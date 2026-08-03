/**
 * 统一格式化 `/status` 输出。
 *
 * 这里消费 AgentSession 提供的结构化快照，不读取配置中的具体模型名称，也不触发
 * 远程目录刷新。上下文窗口和输入预算明确分开，避免把扣除预留后的可用输入上限误报成
 * provider 的原始窗口。
 */
import type { AgentSessionInfo } from "../agent/AgentSession.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { UsageSummary } from "../session/metadata.js";

const numberFormatter = new Intl.NumberFormat("en-US");

export function formatStatusReport(
  info: AgentSessionInfo,
  permissionMode: string,
  context: ContextStatus,
  usage: UsageSummary,
  extensionReport: string
): string {
  const budget = context.budget;
  const contextWindow = budget.contextWindow ?? budget.maxTokens;
  const contextUsed = Math.max(0, budget.usedTokens);
  const contextRemaining = Math.max(0, contextWindow - contextUsed);
  const contextRemainingPercent = contextWindow > 0
    ? Math.max(0, Math.min(100, Math.round((contextRemaining / contextWindow) * 100)))
    : 0;
  const inputRemaining = Math.max(0, budget.maxTokens - contextUsed);
  const source = budget.source ?? "estimated";
  const instructionSummary = context.loadedInstructions.length
    ? `${String(context.loadedInstructions.length)} loaded`
    : "none";
  const repoMapSummary = `${String(context.repoMapEntries)} entries${context.repoMapDirty ? " (dirty)" : ""}`;
  const memorySummary = context.memoryEnabled
    ? context.memoryTopics.length
      ? `enabled (${context.memoryTopics.join(", ")})`
      : "enabled"
    : "disabled";
  const usageSummary = usage.calls
    ? `${formatCount(usage.totalTokens)} total (${formatCount(usage.inputTokens)} input + ${formatCount(usage.outputTokens)} output; ${formatCount(usage.reasoningTokens)} reasoning)`
    : "no model calls recorded";

  return [
    `Model: ${info.modelLabel} (${info.reasoningLabel})`,
    `Model provider: ${info.provider}`,
    `Directory: ${info.workspaceRoot}`,
    `Permissions: ${permissionMode}`,
    `Session: ${info.sessionId}`,
    "",
    `Token usage: ${usageSummary}`,
    `Context window: ${formatCount(contextUsed)} used / ${formatCount(contextWindow)} (${String(contextRemainingPercent)}% remaining; ${source})`,
    `Input budget: ${formatCount(contextUsed)} / ${formatCount(budget.maxTokens)} (${formatCount(inputRemaining)} remaining)`,
    ...(budget.maxOutputTokens !== undefined
      ? [`Output limit: ${formatCount(budget.maxOutputTokens)} tokens`]
      : []),
    `Auto compacted: ${budget.autoCompacted ? "yes" : "no"}`,
    `Compaction: ${context.compaction.summaryPresent ? `active; ${String(context.compaction.compactedMessages)} messages compacted` : "not active"}`,
    `Instructions: ${instructionSummary}; ${formatCount(context.instructionBytes)}/${formatCount(context.instructionCapBytes)} bytes`,
    `Repo map: ${repoMapSummary}`,
    `Memory: ${memorySummary}`,
    ...(context.activePaths.length ? [`Active paths: ${context.activePaths.join(", ")}`] : []),
    ...(budget.omitted.length ? [`Omitted: ${budget.omitted.join(", ")}`] : []),
    "",
    extensionReport
  ].join("\n");
}

function formatCount(value: number): string {
  return numberFormatter.format(Math.max(0, Math.round(value)));
}
