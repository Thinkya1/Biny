/**
 * Tool call 规范化模块。
 *
 * 模型返回的 tool call id 可能缺失或为空；agent 内部统一在进入执行流水线前补齐，
 * 后续 assistant tool_calls、tool result、session event 和 TUI event 都复用同一个 id。
 */
import type { LLMToolCall } from "../llm/provider.js";

export function normalizeToolCalls(toolCalls: LLMToolCall[], round: number): LLMToolCall[] {
  return toolCalls.map((call, index) => ({
    ...call,
    id: normalizedToolCallId(call.id, round, index)
  }));
}

export function normalizedToolCallId(id: string, round: number, index: number): string {
  const trimmed = id.trim();
  return trimmed || `tool-${String(round + 1)}-${String(index + 1)}`;
}
