import type { LanguageModelUsage } from "ai";
import type { ModelPricing } from "../config/schema.js";
import type { SessionUsage, UsageOperation, UsageSummary } from "../session/metadata.js";
import { usageSnapshot } from "../session/metadata.js";

export interface UsageModelInfo {
  modelAlias: string;
  provider: string;
  model: string;
  pricing?: ModelPricing;
}

export type ModelUsageObserver = (usage: LanguageModelUsage, operation: UsageOperation, modelAlias?: string) => Promise<void> | void;

export function createSessionUsage(
  usage: LanguageModelUsage,
  operation: UsageOperation,
  model: UsageModelInfo,
  time = new Date().toISOString()
): SessionUsage {
  const snapshot = usageSnapshot(usage);
  const cost = calculateUsageCost(snapshot, model.pricing);
  return {
    operation,
    modelAlias: model.modelAlias,
    provider: model.provider,
    model: model.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    totalTokens: snapshot.totalTokens,
    reasoningTokens: snapshot.reasoningTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheWriteTokens: snapshot.cacheWriteTokens,
    costUsd: cost.costUsd,
    pricingKnown: cost.known,
    time
  };
}

export function calculateUsageCost(
  usage: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  pricing: ModelPricing | undefined
): { costUsd?: number; known: boolean } {
  if (!pricing) return { costUsd: undefined, known: false };

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const hasTokenData = inputTokens !== undefined || outputTokens !== undefined || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
  if (!hasTokenData) return { costUsd: undefined, known: false };
  let known = true;
  let cost = 0;

  if (inputTokens !== undefined) {
    const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    if (nonCachedInput > 0 && pricing.inputPerMillionTokens === undefined) known = false;
    else cost += (nonCachedInput / 1_000_000) * (pricing.inputPerMillionTokens ?? 0);
  }
  if (cacheReadTokens > 0) {
    if (pricing.cacheReadPerMillionTokens === undefined) known = false;
    else cost += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillionTokens;
  }
  if (cacheWriteTokens > 0) {
    if (pricing.cacheWritePerMillionTokens === undefined) known = false;
    else cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillionTokens;
  }
  if (outputTokens !== undefined) {
    if (outputTokens > 0 && pricing.outputPerMillionTokens === undefined) known = false;
    else cost += (outputTokens / 1_000_000) * (pricing.outputPerMillionTokens ?? 0);
  }

  return { costUsd: known ? cost : undefined, known };
}

export function summarizeUsage(records: SessionUsage[]): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;

  for (const record of records) {
    inputTokens += record.inputTokens ?? 0;
    outputTokens += record.outputTokens ?? 0;
    totalTokens += record.totalTokens ?? 0;
    reasoningTokens += record.reasoningTokens ?? 0;
    cacheReadTokens += record.cacheReadTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    if (record.pricingKnown && record.costUsd !== undefined) {
      costUsd += record.costUsd;
      pricedCalls += 1;
    } else {
      unpricedCalls += 1;
    }
  }

  return {
    calls: records.length,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: unpricedCalls === 0 && records.length > 0 ? costUsd : undefined,
    pricingKnown: records.length > 0 && unpricedCalls === 0,
    pricedCalls,
    unpricedCalls
  };
}

export function formatUsageSummary(summary: UsageSummary): string {
  if (!summary.calls) return "Usage\n\nNo SDK model calls recorded in this session.";
  return [
    "Usage",
    "",
    `Calls: ${String(summary.calls)}`,
    `Input tokens: ${String(summary.inputTokens)}`,
    `Output tokens: ${String(summary.outputTokens)}`,
    `Reasoning tokens: ${String(summary.reasoningTokens)}`,
    `Total tokens: ${String(summary.totalTokens)}`,
    `Cache read/write: ${String(summary.cacheReadTokens)}/${String(summary.cacheWriteTokens)}`,
    `Cost: ${summary.pricingKnown && summary.costUsd !== undefined ? `$${summary.costUsd.toFixed(6)}` : "unknown (configure model pricing)"}`,
    `Priced calls: ${String(summary.pricedCalls)}; unpriced calls: ${String(summary.unpricedCalls)}`
  ].join("\n");
}
