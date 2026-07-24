import type { ModelAliasConfig, ReasoningEffort } from "../config/schema.js";
import type { ModelCapabilities, ModelContextBudget } from "./types.js";

export const defaultModelContextWindow = 32_768;
export const defaultModelOutputTokens = 8_192;

export function modelReasoningConfig(model: ModelAliasConfig): ModelAliasConfig["thinking"] {
  return model.reasoning ?? model.thinking;
}

export function modelCapabilities(model: ModelAliasConfig): ModelCapabilities {
  const reasoning = modelReasoningConfig(model);
  return {
    tools: model.capabilities?.tools ?? model.supportsTools ?? true,
    reasoning: model.capabilities?.reasoning ?? reasoning !== undefined,
    vision: model.capabilities?.vision ?? false,
    audio: model.capabilities?.audio ?? false,
    streaming: model.capabilities?.streaming ?? true
  };
}

export function modelContextBudget(
  model: ModelAliasConfig,
  configuredMaxInputTokens: number,
  modelAlias?: string
): ModelContextBudget {
  const maxOutputTokens = model.maxOutputTokens;
  const contextWindow = model.contextWindow
    ?? Math.max(defaultModelContextWindow, configuredMaxInputTokens + (maxOutputTokens ?? defaultModelOutputTokens));
  const outputReserve = Math.min(
    maxOutputTokens ?? defaultModelOutputTokens,
    Math.max(2_048, Math.floor(contextWindow * 0.25))
  );
  return {
    modelAlias,
    contextWindow,
    maxInputTokens: Math.max(2_048, Math.min(configuredMaxInputTokens, contextWindow - outputReserve)),
    maxOutputTokens
  };
}

export function nativeReasoningEffort(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): string {
  return modelReasoningConfig(model)?.mapping?.[effort] ?? effort;
}

export function reasoningBudgetTokens(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): number {
  return modelReasoningConfig(model)?.budgetTokens?.[effort]
    ?? (effort === "max" || effort === "xhigh" ? 8_192 : effort === "high" ? 4_096 : 2_048);
}
