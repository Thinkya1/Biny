import {
  stepCountIs,
  tool,
  ToolLoopAgent,
  type LanguageModelUsage,
  type StopCondition,
  type ToolExecutionOptions,
  type ToolLoopAgentSettings,
  type ToolSet
} from "ai";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import type { ModelSettings } from "../llm/factory.js";
import { calculateUsageCost, type ModelUsageObserver } from "../observability/usage.js";
import { createSdkTelemetry } from "../observability/telemetry.js";
import type { SubagentTaskManager } from "../runtime/SubagentTaskManager.js";
import { usageSnapshot } from "../session/metadata.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolExecution } from "../tools/types.js";
import { filterProtectedGitDiff, isProtectedCredentialPath, redactSecrets } from "../utils/secrets.js";

const subagentParameters = {
  type: "object" as const,
  properties: {
    task: { type: "string" as const, description: "A focused read-only investigation for the subagent." }
  },
  required: ["task"],
  additionalProperties: false
};

const safeBuiltinCapabilities = new Set([
  "filesystem.read",
  "filesystem.list",
  "filesystem.search",
  "git.status",
  "git.diff"
]);
const maxSubagentReadBytes = 256 * 1024;
const maxSubagentTextChars = 64_000;

export interface SubagentOptions {
  workspaceRoot: string;
  config: AgentConfig;
  getModelSettings: () => ModelSettings;
  getParentRunId?: () => string | undefined;
  toolRegistry: ToolRegistry;
  onUsage?: ModelUsageObserver;
}

export function createSubagentTool(options: SubagentOptions, taskManager: SubagentTaskManager): Tool<{ task: string }, string> {
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
        accesses: ToolAccesses.readTree(options.workspaceRoot),
        display: { kind: "generic", summary: "Delegate read-only investigation", detail: args.task },
        description: "Runs a bounded read-only subagent with an explicit local-tool allowlist.",
        approvalRule: "delegate_task",
        async execute(context): Promise<string> {
          return await taskManager.run(args.task, {
            parentRunId: options.getParentRunId?.() ?? context.toolCallId,
            signal: context.signal
          });
        }
      };
    }
  };
}

/** Executes one already-admitted child task. Concurrency and deadlines belong to SubagentTaskManager. */
export async function runSubagentTask(options: SubagentOptions, task: string, signal?: AbortSignal): Promise<string> {
  const settings = options.config.extensions.subagent;
  const modelSettings = options.getModelSettings();
  const tools = createReadOnlyTools(options.toolRegistry, settings.allowedTools);
  const costBudgetStop: StopCondition<ToolSet> = ({ steps }) => subagentCostBudgetReached(
    options.config,
    steps.map((step) => step.usage)
  );
  const agent = new ToolLoopAgent<never, ToolSet>({
    model: modelSettings.model,
    tools,
    instructions: [
      "You are Biny's bounded read-only subagent.",
      "Inspect the repository using only the available local read/search/git inspection tools.",
      "Never request secrets, credentials, environment files, agent.config.json, network access, writes, shell commands, or another subagent.",
      "Return concise grounded findings with exact paths."
    ].join("\n"),
    stopWhen: [stepCountIs(settings.maxSteps), costBudgetStop],
    maxRetries: 0,
    providerOptions: modelSettings.providerOptions,
    reasoning: modelSettings.reasoning,
    timeout: modelSettings.timeoutMs,
    maxOutputTokens: subagentMaxOutputTokens(options.config, modelSettings.maxOutputTokens),
    telemetry: createSdkTelemetry(options.config, options.workspaceRoot, "biny.subagent"),
    onError: () => undefined
  } as ToolLoopAgentSettings<never, ToolSet> & { onError: () => undefined });
  const result = await agent.generate({ prompt: task, abortSignal: signal });
  const usage = await result.usage;
  if (signal?.aborted) throw abortReason(signal);
  const modelAlias = settings.model ?? options.config.defaultModel;
  await options.onUsage?.(usage, "subagent", modelAlias);
  enforceSubagentCostBudget(options.config, usage);
  return redactSecrets(result.text);
}

export function createReadOnlyTools(registry: ToolRegistry, allowedTools: readonly string[]): ToolSet {
  const tools: Record<string, unknown> = {};
  const allowed = new Set(allowedTools);
  for (const entry of registry.listEntries()) {
    if (
      entry.source !== "builtin"
      || entry.tool.risk !== "read"
      || !entry.tool.capability
      || !safeBuiltinCapabilities.has(entry.tool.capability)
      || !allowed.has(entry.tool.name)
    ) continue;
    tools[entry.tool.name] = tool({
      description: entry.tool.description,
      inputSchema: entry.tool.schema,
      execute: async (input: unknown, executionOptions: ToolExecutionOptions<unknown>) => {
        assertSafeToolInput(entry.tool.name, input);
        const resolved = await entry.tool.resolveExecution(input);
        const result = await executeReadOnlyTool(entry.tool.name, resolved, executionOptions);
        return sanitizeToolResult(entry.tool.name, result);
      }
    });
  }
  return tools as ToolSet;
}

export function enforceSubagentCostBudget(config: AgentConfig, usage: LanguageModelUsage): void {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return;
  const alias = subagentModelAlias(config);
  const cost = calculateUsageCost(usageSnapshot(usage), config.models[alias]?.pricing);
  if (!cost.known || cost.costUsd === undefined) {
    throw new Error(`Cannot enforce the subagent cost stop threshold for ${alias}: model pricing is incomplete.`);
  }
  if (cost.costUsd > budget) {
    throw new Error(`Subagent cost $${cost.costUsd.toFixed(6)} exceeded the configured $${budget.toFixed(6)} stop threshold.`);
  }
}

export function subagentCostBudgetReached(config: AgentConfig, usages: readonly LanguageModelUsage[]): boolean {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return false;
  const alias = subagentModelAlias(config);
  const pricing = config.models[alias]?.pricing;
  let totalCostUsd = 0;
  for (const usage of usages) {
    const cost = calculateUsageCost(usageSnapshot(usage), pricing);
    if (!cost.known || cost.costUsd === undefined) {
      throw new Error(`Cannot enforce the subagent cost stop threshold for ${alias}: model pricing is incomplete.`);
    }
    totalCostUsd += cost.costUsd;
  }
  return totalCostUsd >= budget;
}

export function subagentMaxOutputTokens(config: AgentConfig, modelMaxOutputTokens?: number): number {
  const settings = config.extensions.subagent;
  const configuredLimit = Math.min(settings.maxOutputTokens, modelMaxOutputTokens ?? settings.maxOutputTokens);
  if (settings.maxCostUsd === undefined) return configuredLimit;
  const outputPrice = config.models[subagentModelAlias(config)]?.pricing?.outputPerMillionTokens;
  if (outputPrice === undefined) throw new Error("Cannot derive the subagent output limit from the cost stop threshold: model output pricing is incomplete.");
  if (outputPrice === 0) return configuredLimit;
  const budgetTokenLimit = Math.max(1, Math.floor((settings.maxCostUsd * 1_000_000) / outputPrice));
  return Math.min(configuredLimit, budgetTokenLimit);
}

export function isSensitiveSubagentPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (isProtectedCredentialPath(normalized)) return true;
  return normalized.split("/").some((segment) => {
    const lower = segment.toLowerCase().replace(/^"|"$/g, "");
    return lower === ".agent" || lower === ".ssh" || lower === ".npmrc" || lower === ".netrc" || lower.startsWith(".env");
  });
}

async function executeReadOnlyTool(toolName: string, execution: ToolExecution, options: ToolExecutionOptions<unknown>): Promise<unknown> {
  if ("isError" in execution) return execution.result;
  if (toolName === "read_file") {
    const filePath = execution.accesses?.find((access) => access.kind === "file")?.path;
    if (filePath) {
      const stat = await fs.stat(filePath);
      if (stat.size > maxSubagentReadBytes) {
        throw new Error(`Subagent read_file limit exceeded (${String(stat.size)} bytes; max ${String(maxSubagentReadBytes)}). Use search instead.`);
      }
    }
  }
  return await execution.execute({ toolCallId: options.toolCallId, signal: options.abortSignal });
}

function assertSafeToolInput(toolName: string, input: unknown): void {
  if (toolName !== "read_file" || !isRecord(input) || typeof input.path !== "string") return;
  if (isSensitiveSubagentPath(input.path)) throw new Error(`Subagent access denied for protected path: ${input.path}`);
}

function sanitizeToolResult(toolName: string, result: unknown): unknown {
  if (toolName === "list_files" && isRecord(result) && Array.isArray(result.files)) {
    return { ...result, files: result.files.filter((file): file is string => typeof file === "string" && !isSensitiveSubagentPath(file)) };
  }
  if ((toolName === "search_files" || toolName === "grep_search") && isRecord(result) && Array.isArray(result.matches)) {
    return {
      ...result,
      matches: result.matches
        .filter((match) => !isRecord(match) || typeof match.path !== "string" || !isSensitiveSubagentPath(match.path))
        .map(redactUnknown)
    };
  }
  if ((toolName === "git_diff" || toolName === "git_status") && isRecord(result) && typeof result.output === "string") {
    const output = toolName === "git_diff" ? filterProtectedGitDiff(result.output) : filterProtectedStatus(result.output);
    return { ...result, output: redactSecrets(output) };
  }
  return redactUnknown(result);
}

function filterProtectedStatus(output: string): string {
  return output.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    const path = line.slice(3).split(" -> ").at(-1) ?? "";
    return !isSensitiveSubagentPath(path);
  }).join("\n");
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length <= maxSubagentTextChars
      ? redacted
      : `${redacted.slice(0, maxSubagentTextChars)}\n[truncated by subagent tool limit]`;
  }
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subagentModelAlias(config: AgentConfig): string {
  return config.extensions.subagent.model ?? config.defaultModel;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Subagent task was cancelled.");
}
