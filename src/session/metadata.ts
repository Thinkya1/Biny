import type { LanguageModelUsage } from "ai";

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

export function usageSnapshot(usage: LanguageModelUsage): Omit<SessionUsage, "operation" | "modelAlias" | "provider" | "model" | "costUsd" | "pricingKnown" | "time"> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens
  };
}
