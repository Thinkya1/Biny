import { stepCountIs, tool, ToolLoopAgent, type LanguageModel, type ToolExecutionOptions, type ToolLoopAgentSettings, type ToolSet } from "ai";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import type { ModelSettings } from "../llm/factory.js";
import type { ModelUsageObserver } from "../observability/usage.js";
import { createSdkTelemetry } from "../observability/telemetry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolExecution } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";

const subagentParameters = {
  type: "object" as const,
  properties: {
    task: { type: "string" as const, description: "A focused read-only investigation for the subagent." }
  },
  required: ["task"],
  additionalProperties: false
};

export interface SubagentOptions {
  workspaceRoot: string;
  config: AgentConfig;
  getModel: () => LanguageModel;
  getModelSettings: () => Pick<ModelSettings, "providerOptions" | "reasoning">;
  toolRegistry: ToolRegistry;
  onUsage?: ModelUsageObserver;
}

export function createSubagentTool(options: SubagentOptions): Tool<{ task: string }, string> {
  return {
    name: "delegate_task",
    description: "Delegate a focused read-only repository investigation to a subagent, then return its answer.",
    parameters: subagentParameters,
    schema: z.object({ task: z.string().min(1).max(20_000) }),
    source: "subagent",
    capability: "subagent.readonly",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.all(),
        display: { kind: "generic", summary: "Delegate read-only investigation", detail: args.task },
        description: "Runs a bounded read-only subagent with no write or shell tools.",
        approvalRule: "delegate_task",
        async execute(context): Promise<string> {
          return await runSubagentTask(options, args.task, context.signal);
        }
      };
    }
  };
}

export async function runSubagentTask(options: SubagentOptions, task: string, signal?: AbortSignal): Promise<string> {
  const tools = createReadOnlyTools(options.toolRegistry);
  const settings = options.config.extensions.subagent;
  const agent = new ToolLoopAgent<never, ToolSet>({
    model: options.getModel(),
    tools,
    instructions: [
      "You are Biny's bounded read-only subagent.",
      "Inspect the repository using the available read/search/git inspection tools.",
      "Do not modify files, run shell commands, or delegate another subagent.",
      "Return concise grounded findings with exact paths."
    ].join("\n"),
    stopWhen: stepCountIs(settings.maxSteps),
    maxRetries: 0,
    providerOptions: options.getModelSettings().providerOptions,
    reasoning: options.getModelSettings().reasoning,
    maxOutputTokens: settings.maxOutputTokens,
    telemetry: createSdkTelemetry(options.config, options.workspaceRoot, "biny.subagent"),
    onError: () => undefined
  } as ToolLoopAgentSettings<never, ToolSet> & { onError: () => undefined });
  const result = await agent.generate({ prompt: task, abortSignal: signal });
  await options.onUsage?.(await result.usage, "subagent");
  return result.text;
}

function createReadOnlyTools(registry: ToolRegistry): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const entry of registry.listEntries()) {
    if (entry.source !== "builtin" || entry.tool.risk !== "read") continue;
    tools[entry.tool.name] = tool({
      description: entry.tool.description,
      inputSchema: entry.tool.schema,
      execute: async (input: unknown, executionOptions: ToolExecutionOptions<unknown>) => {
        const resolved = await entry.tool.resolveExecution(input);
        return await executeReadOnlyTool(resolved, executionOptions);
      }
    });
  }
  return tools as ToolSet;
}

async function executeReadOnlyTool(execution: ToolExecution, options: ToolExecutionOptions<unknown>): Promise<unknown> {
  if ("isError" in execution) return execution.result;
  return await execution.execute({ toolCallId: options.toolCallId, signal: options.abortSignal });
}
