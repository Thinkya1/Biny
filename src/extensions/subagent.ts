import { promises as fs } from "node:fs";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import { agentLoop } from "../agent/core/agentLoop.js";
import type { AgentAssistantMessage, AgentTool, AgentUsage } from "../agent/core/types.js";
import type { NativeModelSettings } from "../llm/nativeFactory.js";
import { calculateUsageCost, type ModelUsageObserver } from "../observability/usage.js";
import type { SubagentTaskManager } from "../runtime/SubagentTaskManager.js";
import type { SubagentAccessMode } from "../runtime/SubagentTaskManager.js";
import { usageSnapshot } from "../session/metadata.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolScheduler } from "../tools/scheduler.js";
import type { RunnableToolExecution, Tool } from "../tools/types.js";
import { filterProtectedGitDiff, isProtectedCredentialPath, redactSecrets } from "../utils/secrets.js";
import { findSubagentDefinition, type SubagentDefinition } from "./agents.js";

const subagentParameters = {
  type: "object" as const,
  properties: {
    task: { type: "string" as const, description: "A focused repository task for the subagent, including implementation and finite validation when needed." },
    agent: { type: "string" as const, description: "Optional named subagent definition to run this task with (see the named subagents list). Omit for the default bounded subagent." }
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
  /** 不带别名时返回 subagent 默认模型设置；带别名时返回该模型别名的设置。 */
  getModelSettings: (modelAlias?: string) => NativeModelSettings;
  getAccessMode: () => SubagentAccessMode;
  getParentRunId?: () => string | undefined;
  /** 每次委派时重新读取具名定义，允许会话期间编辑生效。 */
  loadAgentDefinitions?: () => Promise<SubagentDefinition[]>;
  toolRegistry: ToolRegistry;
  onUsage?: ModelUsageObserver;
}

export function createSubagentTool(options: SubagentOptions, taskManager: SubagentTaskManager): Tool<{ task: string; agent?: string }, string> {
  return {
    name: "delegate_task",
    description: "Delegate a focused repository investigation, implementation, repair, or finite validation task to a bounded subagent. Pass agent to run a named subagent definition.",
    promptSnippet: "Delegate a focused, bounded workspace task to a subagent",
    parameters: subagentParameters,
    schema: z.object({ task: z.string().min(1).max(20_000), agent: z.string().trim().min(1).max(64).optional() }),
    source: "subagent",
    capability: "subagent.workspace",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.all(),
        display: {
          kind: "generic",
          summary: args.agent ? `Delegate to subagent ${args.agent}` : "Delegate repository task",
          detail: args.task
        },
        description: "Runs a bounded workspace subagent with an explicit local-tool allowlist and restricted validation commands.",
        approvalRule: "delegate_task",
        async execute(context): Promise<string> {
          return await taskManager.run(args.task, {
            parentRunId: options.getParentRunId?.() ?? context.toolCallId,
            signal: context.signal,
            accessMode: options.getAccessMode(),
            agent: args.agent
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
  accessMode: SubagentAccessMode = "read-only",
  agentName?: string
): Promise<string> {
  const settings = options.config.extensions.subagent;
  const definition = await resolveSubagentDefinition(options, agentName);
  const modelSettings = options.getModelSettings(definition?.model);
  const modelAlias = definition?.model ?? settings.model ?? options.config.defaultModel;
  // 具名定义的 tools 只做收窄：始终与全局 allowedTools 求交集，不能放宽安全边界。
  const allowedTools = definition?.tools
    ? settings.allowedTools.filter((toolName) => definition.tools?.includes(toolName))
    : settings.allowedTools;
  return await runNativeSubagentTask(options, task, modelSettings, modelAlias, definition, signal, accessMode, allowedTools);
}

async function runNativeSubagentTask(
  options: SubagentOptions,
  task: string,
  modelSettings: NativeModelSettings,
  modelAlias: string,
  definition: SubagentDefinition | undefined,
  signal: AbortSignal | undefined,
  accessMode: SubagentAccessMode,
  allowedTools: readonly string[]
): Promise<string> {
  const model = modelSettings.model;
  if (model.supportsTools === false) {
    throw new Error(`Subagent model ${modelAlias} does not support tools.`);
  }
  const scheduler = new ToolScheduler<unknown>({
    maxConcurrency: options.config.agent.maxConcurrentTools,
    maxQueuedTasks: options.config.agent.maxQueuedToolCalls
  });
  const tools = createSubagentTools(options.toolRegistry, allowedTools, { accessMode, scheduler });
  const instructions = [
    accessMode === "workspace" ? "You are Biny's bounded workspace subagent." : "You are Biny's bounded read-only subagent.",
    accessMode === "workspace"
      ? "Inspect, implement, repair, and validate the focused task using only the explicitly available workspace tools."
      : "Inspect the repository using only the available local read/search/git inspection tools.",
    "Never request secrets, credentials, environment files, config.json, network access, long-running processes, or another subagent.",
    "Use run_command only for finite allowlisted build, test, lint, and typecheck commands.",
    "Return concise grounded findings with exact paths, changes, and validation evidence.",
    ...(definition ? ["", `Named subagent role "${definition.name}":`, definition.prompt] : [])
  ].join("\n");
  const usages: AgentUsage[] = [];
  const assistantTexts: string[] = [];
  let lastAssistant: AgentAssistantMessage | undefined;
  let fatalError: string | undefined;
  const loop = agentLoop([{ role: "user", content: task }], {
    systemPrompt: instructions,
    messages: [],
    tools
  }, {
    model,
    tools,
    modelOptions: {
      maxOutputTokens: subagentMaxOutputTokens(options.config, modelSettings.maxOutputTokens, modelAlias),
      reasoning: modelSettings.reasoning,
      providerOptions: modelSettings.providerOptions,
      timeoutMs: modelSettings.timeoutMs
    },
    maxSteps: subagentStepBudget(task, options.config.extensions.subagent.maxSteps),
    shouldStopAfterTurn: async (turn) => {
      lastAssistant = turn.message;
      if (turn.message.usage) usages.push(turn.message.usage);
      if (subagentCostBudgetReached(options.config, usages, modelAlias)) return true;
      return !turn.message.content.some((part) => part.type === "toolCall");
    }
  }, signal);
  for await (const event of loop) {
    if (event.type === "error" && event.fatal) fatalError = event.error;
    if (event.type === "turn_end") {
      lastAssistant = event.message;
      const text = agentMessageText(event.message);
      if (text) assistantTexts.push(text);
    }
  }
  if (signal?.aborted) throw abortReason(signal);
  if (fatalError) throw new Error(fatalError);
  const usage = usages.length ? sumNativeUsage(usages) : undefined;
  if (usage) {
    await options.onUsage?.(usage, "subagent", modelAlias);
    enforceSubagentCostBudget(options.config, usage, modelAlias);
  }
  if (!lastAssistant) throw new Error("Subagent produced no assistant message.");
  const output = agentMessageText(lastAssistant);
  if (lastAssistant.content.some((part) => part.type === "toolCall")) {
    return redactSecrets(formatPartialSubagentOutput(assistantTexts.map((text) => ({ text }))));
  }
  if (lastAssistant.stopReason !== undefined && !["stop", "other"].includes(lastAssistant.stopReason)) {
    throw new Error(`Subagent did not reach a terminal model stop (stopReason=${lastAssistant.stopReason}).`);
  }
  return redactSecrets(output);
}

export function createSubagentTools(
  registry: ToolRegistry,
  allowedTools: readonly string[],
  options: CreateSubagentToolsOptions = {}
): AgentTool[] {
  const allowed = new Set(allowedTools);
  const accessMode = options.accessMode ?? "read-only";
  const capabilities = accessMode === "workspace" ? workspaceBuiltinCapabilities : safeBuiltinCapabilities;
  return registry.listEntries().flatMap(({ tool: entry, source }) => {
    if (
      source !== "builtin"
      || !entry.capability
      || !capabilities.has(entry.capability)
      || (accessMode === "read-only" && entry.risk !== "read")
      || !allowed.has(entry.name)
    ) return [];
    const nativeTool: AgentTool = {
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      executionMode: entry.risk === "read" ? "parallel" : "sequential",
      execute: async (toolCallId, args, signal) => {
        assertSafeToolInput(entry.name, args, accessMode);
        const resolved = await entry.resolveExecution(args);
        if ("isError" in resolved) {
          return { content: [{ type: "text", text: stringifySubagentValue(resolved.result) }], details: resolved.result, isError: true };
        }
        try {
          const result = await executeNativeSubagentTool(entry.name, resolved, toolCallId, signal, options.scheduler);
          const sanitized = sanitizeToolResult(entry.name, result);
          return { content: [{ type: "text", text: stringifySubagentValue(sanitized) }], details: sanitized };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }
    };
    return [nativeTool];
  });
}

async function executeNativeSubagentTool(
  toolName: string,
  execution: RunnableToolExecution,
  toolCallId: string,
  signal: AbortSignal | undefined,
  scheduler?: ToolScheduler<unknown>
): Promise<unknown> {
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
    return await execution.execute({ toolCallId, signal });
  };
  return scheduler
    ? await scheduler.schedule({ accesses: execution.accesses ?? ToolAccesses.all(), signal, start: execute })
    : await execute();
}

function sumNativeUsage(usages: readonly AgentUsage[]): AgentUsage {
  return {
    inputTokens: sumUsageField(usages, "inputTokens"),
    outputTokens: sumUsageField(usages, "outputTokens"),
    totalTokens: sumUsageField(usages, "totalTokens"),
    reasoningTokens: sumUsageField(usages, "reasoningTokens"),
    cacheReadTokens: sumUsageField(usages, "cacheReadTokens"),
    cacheWriteTokens: sumUsageField(usages, "cacheWriteTokens")
  };
}

function sumUsageField(usages: readonly AgentUsage[], field: keyof AgentUsage): number | undefined {
  const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function agentMessageText(message: AgentAssistantMessage): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function stringifySubagentValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

function formatPartialSubagentOutput(steps: ReadonlyArray<{ text: string }>): string {
  const collected = steps.map((step) => step.text.trim()).filter(Boolean);
  const note = `[Partial result: the bounded subagent budget ran out after ${String(steps.length)} steps while it was still requesting tools. Treat the findings below as incomplete; narrow the task or raise extensions.subagent.maxSteps for full coverage.]`;
  if (!collected.length) return `${note}\n\n(The subagent produced no findings text before the budget ran out.)`;
  return [note, ...collected].join("\n\n");
}

async function resolveSubagentDefinition(options: SubagentOptions, agentName?: string): Promise<SubagentDefinition | undefined> {
  if (!agentName) return undefined;
  const definitions = await options.loadAgentDefinitions?.() ?? [];
  const definition = findSubagentDefinition(definitions, agentName);
  if (!definition) {
    const known = definitions.map((entry) => entry.name).join(", ") || "none";
    throw new Error(`Unknown named subagent: ${agentName}. Available definitions: ${known}.`);
  }
  return definition;
}

export interface CreateSubagentToolsOptions {
  accessMode?: SubagentAccessMode;
  scheduler?: ToolScheduler<unknown>;
}

export function createReadOnlyTools(registry: ToolRegistry, allowedTools: readonly string[]): AgentTool[] {
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

export function enforceSubagentCostBudget(config: AgentConfig, usage: AgentUsage, modelAlias?: string): void {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return;
  const alias = modelAlias ?? subagentModelAlias(config);
  const cost = calculateUsageCost(usageSnapshot(usage), config.models[alias]?.pricing);
  if (!cost.known || cost.costUsd === undefined) {
    throw new Error(`Cannot enforce the subagent cost stop threshold for ${alias}: model pricing is incomplete.`);
  }
  if (cost.costUsd > budget) {
    throw new Error(`Subagent cost $${cost.costUsd.toFixed(6)} exceeded the configured $${budget.toFixed(6)} stop threshold.`);
  }
}

export function subagentCostBudgetReached(config: AgentConfig, usages: readonly AgentUsage[], modelAlias?: string): boolean {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return false;
  const alias = modelAlias ?? subagentModelAlias(config);
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

export function subagentMaxOutputTokens(config: AgentConfig, modelMaxOutputTokens?: number, modelAlias?: string): number {
  const settings = config.extensions.subagent;
  const configuredLimit = Math.min(settings.maxOutputTokens, modelMaxOutputTokens ?? settings.maxOutputTokens);
  if (settings.maxCostUsd === undefined) return configuredLimit;
  const outputPrice = config.models[modelAlias ?? subagentModelAlias(config)]?.pricing?.outputPerMillionTokens;
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
    return lower === ".biny" || lower === ".agent" || lower === ".ssh" || lower === ".npmrc" || lower === ".netrc" || lower.startsWith(".env");
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
