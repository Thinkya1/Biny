/**
 * Session 元数据类型：token 用量、费用和上下文预算。
 *
 * 这些结构会原样写进 session 文件，属于对外的持久化格式，改字段要考虑历史 session 的
 * 兼容性，因此除 `operation` 等必需项外都保持可选。
 */
import type { AgentUsage } from "../agent/core/types.js";

export type UsageOperation = "agent" | "plan" | "compaction" | "memory" | "subagent";
export type ContextBudgetSource = "estimated" | "provider";

export interface SessionContextUsage {
  maxTokens: number;
  usedTokens: number;
  omitted: string[];
  autoCompacted: boolean;
  source?: ContextBudgetSource;
  measuredAt?: string;
}

export interface SessionContextState {
  summary?: string;
  compactedMessages: number;
  lastCompactedAt?: string;
  memoryTopics: string[];
  budget: SessionContextUsage;
}

export interface SessionUsage {
  operation: UsageOperation;
  modelAlias: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
  time?: string;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  pricingKnown: boolean;
  pricedCalls: number;
  unpricedCalls: number;
}

export function usageSnapshot(usage: AgentUsage): Omit<SessionUsage, "operation" | "modelAlias" | "provider" | "model" | "costUsd" | "pricingKnown" | "time"> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  };
}
