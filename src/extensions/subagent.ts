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
import type { SubagentAccessMode } from "../runtime/SubagentTaskManager.js";
import { usageSnapshot } from "../session/metadata.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolScheduler } from "../tools/scheduler.js";
import type { Tool, ToolExecution } from "../tools/types.js";
import { filterProtectedGitDiff, isProtectedCredentialPath, redactSecrets } from "../utils/secrets.js";

const subagentParameters = {
  type: "object" as const,
  properties: {
    task: { type: "string" as const, description: "A focused repository task for the subagent, including implementation and finite validation when needed." }
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
const workspaceBuiltinCapabilities = new Set([
  ...safeBuiltinCapabilities,
  "filesystem.write",
  "filesystem.edit",
  "filesystem.delete",
  "filesystem.move",
  "shell.execute"
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
    description: "Delegate a focused repository investigation, implementation, repair, or finite validation task to a bounded subagent.",
    parameters: subagentParameters,
    schema: z.object({ task: z.string().min(1).max(20_000) }),
    source: "subagent",
    capability: "subagent.workspace",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.all(),
        display: { kind: "generic", summary: "Delegate repository task", detail: args.task },
        description: "Runs a bounded workspace subagent with an explicit local-tool allowlist and restricted validation commands.",
        approvalRule: "delegate_task",
        async execute(context): Promise<string> {
          return await taskManager.run(args.task, {
            parentRunId: options.getParentRunId?.() ?? context.toolCallId,
            signal: context.signal,
            accessMode: "workspace"
          });
        }
      };
    }
  };
}

/** Executes one already-admitted child task. Concurrency and deadlines belong to SubagentTaskManager. */
export async function runSubagentTask(
  options: SubagentOptions,
  task: string,
  signal?: AbortSignal,
  accessMode: SubagentAccessMode = "read-only"
): Promise<string> {
  const settings = options.config.extensions.subagent;
  const modelSettings = options.getModelSettings();
  const scheduler = new ToolScheduler<unknown>({
    maxConcurrency: options.config.agent.maxConcurrentTools,
    maxQueuedTasks: options.config.agent.maxQueuedToolCalls
  });
  const tools = createSubagentTools(options.toolRegistry, settings.allowedTools, { accessMode, scheduler });
  const costBudgetStop: StopCondition<ToolSet> = ({ steps }) => subagentCostBudgetReached(
    options.config,
    steps.map((step) => step.usage)
  );
  const agent = new ToolLoopAgent<never, ToolSet>({
    model: modelSettings.model,
    tools,
    instructions: [
      accessMode === "workspace" ? "You are Biny's bounded workspace subagent." : "You are Biny's bounded read-only subagent.",
      accessMode === "workspace"
        ? "Inspect, implement, repair, and validate the focused task using only the explicitly available workspace tools."
        : "Inspect the repository using only the available local read/search/git inspection tools.",
      "Never request secrets, credentials, environment files, agent.config.json, network access, long-running processes, or another subagent.",
      "Use run_command only for finite allowlisted build, test, lint, and typecheck commands.",
      "Return concise grounded findings with exact paths, changes, and validation evidence."
    ].join("\n"),
    stopWhen: [stepCountIs(subagentStepBudget(task, settings.maxSteps)), costBudgetStop],
    maxRetries: modelSettings.maxRetries,
    providerOptions: modelSettings.providerOptions,
    reasoning: modelSettings.reasoning,
    timeout: modelSettings.timeoutMs,
    maxOutputTokens: subagentMaxOutputTokens(options.config, modelSettings.maxOutputTokens),
    telemetry: createSdkTelemetry(options.config, options.workspaceRoot, "biny.subagent"),
    onError: () => undefined
  } as ToolLoopAgentSettings<never, ToolSet> & { onError: () => undefined });
  const result = await agent.generate({ prompt: task, abortSignal: signal });
  const [text, usage, finalStep, steps] = await Promise.all([
    result.text,
    result.usage,
    result.finalStep,
    result.steps
  ]);
  if (signal?.aborted) throw abortReason(signal);
  const modelAlias = settings.model ?? options.config.defaultModel;
  await options.onUsage?.(usage, "subagent", modelAlias);
  enforceSubagentCostBudget(options.config, usage);
  if (finalStep.finishReason !== "stop") {
    throw new Error(`Subagent did not reach a terminal model stop after ${String(steps.length)} steps (finishReason=${finalStep.finishReason}).`);
  }
  return redactSecrets(text);
}

export interface CreateSubagentToolsOptions {
  accessMode?: SubagentAccessMode;
  scheduler?: ToolScheduler<unknown>;
}

export function createSubagentTools(
  registry: ToolRegistry,
  allowedTools: readonly string[],
  options: CreateSubagentToolsOptions = {}
): ToolSet {
  const tools: Record<string, unknown> = {};
  const allowed = new Set(allowedTools);
  const accessMode = options.accessMode ?? "read-only";
  const capabilities = accessMode === "workspace" ? workspaceBuiltinCapabilities : safeBuiltinCapabilities;
  for (const entry of registry.listEntries()) {
    if (
      entry.source !== "builtin"
      || !entry.tool.capability
      || !capabilities.has(entry.tool.capability)
      || (accessMode === "read-only" && entry.tool.risk !== "read")
      || !allowed.has(entry.tool.name)
    ) continue;
    tools[entry.tool.name] = tool({
      description: entry.tool.description,
      inputSchema: entry.tool.schema,
      execute: async (input: unknown, executionOptions: ToolExecutionOptions<unknown>) => {
        assertSafeToolInput(entry.tool.name, input, accessMode);
        const resolved = await entry.tool.resolveExecution(input);
        const result = await executeSubagentTool(entry.tool.name, resolved, executionOptions, options.scheduler);
        return sanitizeToolResult(entry.tool.name, result);
      }
    });
  }
  return tools as ToolSet;
}

/** Backward-compatible read-only view used by review and inspection callers. */
export function createReadOnlyTools(registry: ToolRegistry, allowedTools: readonly string[]): ToolSet {
  return createSubagentTools(registry, allowedTools, { accessMode: "read-only" });
}

export function subagentStepBudget(task: string, configuredMaximum: number): number {
  if (!Number.isSafeInteger(configuredMaximum) || configuredMaximum < 1) {
    throw new RangeError("Subagent maxSteps must be a positive safe integer.");
  }
  const compact = task.trim().toLowerCase();
  const implementationTask = /\b(implement|fix|repair|refactor|change|update|write|edit|test|build|lint|typecheck)\b|实现|修复|修改|重构|编写|测试|构建|检查/.test(compact);
  if (implementationTask) return configuredMaximum;
  const broadInvestigation = compact.length > 400 || /\b(investigate|analyze|audit|trace|compare)\b|调查|分析|审计|追踪|对比/.test(compact);
  if (broadInvestigation) return Math.min(configuredMaximum, 12);
  return Math.min(configuredMaximum, 8);
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

async function executeSubagentTool(
  toolName: string,
  execution: ToolExecution,
  options: ToolExecutionOptions<unknown>,
  scheduler?: ToolScheduler<unknown>
): Promise<unknown> {
  if ("isError" in execution) return execution.result;
  const execute = async (): Promise<unknown> => {
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
  };
  if (!scheduler) return await execute();
  return await scheduler.schedule({
    accesses: execution.accesses ?? ToolAccesses.all(),
    signal: options.abortSignal,
    start: execute
  });
}

function assertSafeToolInput(toolName: string, input: unknown, accessMode: SubagentAccessMode): void {
  if (!isRecord(input)) return;
  if (typeof input.path === "string" && isSensitiveSubagentPath(input.path)) {
    throw new Error(`Subagent access denied for protected path: ${input.path}`);
  }
  if (toolName === "run_command") {
    if (accessMode !== "workspace") throw new Error("Subagent command execution is not available in read-only mode.");
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!isAllowedSubagentValidationCommand(command)) {
      throw new Error("Subagent run_command only permits finite build, test, lint, and typecheck commands without shell operators.");
    }
  }
}

export function isAllowedSubagentValidationCommand(command: string): boolean {
  // The command is passed to a shell. Only horizontal ASCII whitespace is
  // accepted so a newline cannot smuggle a second command past this allowlist.
  if (!command || !/^[\w@%+.,:/=\- \t]+$/u.test(command)) return false;
  const words = command.trim().split(/[ \t]+/u);
  const executable = words[0] ?? "";
  const firstArgument = words[1] ?? "";
  const secondArgument = words[2] ?? "";
  if (["pnpm", "npm", "yarn", "bun"].includes(executable)) {
    if (["test", "build", "lint", "typecheck", "check"].includes(firstArgument)) return true;
    if (firstArgument === "run" && ["test", "build", "lint", "typecheck", "check"].includes(secondArgument)) return true;
    return executable === "pnpm" && firstArgument === "exec" && ["tsc", "eslint", "vitest", "jest"].includes(secondArgument);
  }
  if (["mvn", "./mvnw"].includes(executable)) return ["test", "verify", "package"].includes(firstArgument);
  if (["gradle", "./gradlew"].includes(executable)) return ["test", "check", "build"].includes(firstArgument);
  if (executable === "cargo") return ["test", "check", "build", "clippy"].includes(firstArgument);
  if (executable === "go") return firstArgument === "test";
  if (["pytest", "py.test"].includes(executable)) return true;
  if (["python", "python3"].includes(executable)) return firstArgument === "-m" && secondArgument === "pytest";
  if (executable === "dotnet") return ["test", "build"].includes(firstArgument);
  if (executable === "make") return ["test", "check", "build", "lint"].includes(firstArgument);
  return false;
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
