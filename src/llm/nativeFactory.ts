/**
 * 自有 Agent Runtime 的模型工厂。
 *
 * 只组装配置、凭据和原生 fetch transport，不创建或依赖模型 SDK。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig, ModelAliasConfig, ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";
import { isKimiK3Model, modelCapabilities, modelReasoningConfig, nativeReasoningEffort, reasoningBudgetTokens } from "../ai/capabilities.js";
import { providerProtocol } from "../ai/provider.js";
import { createRetryFetch } from "../ai/retry.js";
import { providerProfile } from "./profiles.js";
import { createNativeModel } from "./nativeModel.js";
import { openAiCodexHeaders } from "./subscriptionAuth.js";

export interface NativeModelSettings {
  model: AgentModel;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxRetries: number;
  contextWindow: number | undefined;
}

export function createNativeModelForConfig(config: AgentConfig, alias = config.defaultModel): AgentModel {
  return createNativeModelSettings(config, alias).model;
}

export function createNativeModelSettings(config: AgentConfig, alias = config.defaultModel): NativeModelSettings {
  const resolved = resolveNativeModelConfig(config, alias);
  const profile = providerProfile(resolved.provider.type);
  const apiKey = resolveApiKey(resolved.provider.apiKey, resolved.provider.apiKeyEnv, profile.apiKeyEnv);
  if ((resolved.provider.requiresApiKey ?? profile.requiresApiKey) && !apiKey) {
    throw new Error(missingKeyMessage(resolved.providerAlias, resolved.provider.apiKeyEnv, profile.apiKeyEnv));
  }
  const baseUrl = resolved.model.baseUrl ?? resolved.provider.baseUrl ?? profile.baseUrl;
  if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${resolved.providerAlias}.baseUrl.`);
  validateEndpointAndCredentials(resolved.providerAlias, resolved.provider, profile, baseUrl, apiKey);

  const protocol = nativeProtocolForModel(resolved.model, resolved.provider, profile);
  const apiBackend = resolved.model.apiBackend
    ?? resolved.provider.apiBackend
    ?? (resolved.provider.type === "openai-codex"
      ? "responses"
      : protocol === "anthropic" ? "anthropic_messages" : "chat_completions");

  const capabilities = modelCapabilities(resolved.model);
  const enabled = config.thinking.enabled && capabilities.reasoning && modelReasoningConfig(resolved.model) !== undefined;
  const effort = enabled ? config.thinking.effort : undefined;
  const retry = resolved.provider.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const compatibility = mergeCompatibility(resolved.provider.compatibility, resolved.model.compatibility);
  const providerOptions = createNativeProviderOptions(resolved.provider.type, resolved.provider, resolved.model, enabled, effort);

  return {
    model: createNativeModel({
      provider: resolved.provider.type,
      modelId: resolved.model.model,
      protocol: apiBackend === "responses" ? "openai-responses" : protocol,
      baseUrl,
      apiKey,
      headers: {
        ...(resolved.provider.type === "openai-codex" ? openAiCodexHeaders(apiKey) : {}),
        ...resolved.model.headers
      },
      fetch: createRetryFetch(retry),
      maxTokensField: compatibility?.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
      // OpenAI-compatible gateways generally implement the older `system` role.
      // Even an `openai` provider may point at a relay, so `developer` is opt-in.
      supportsDeveloperRole: compatibility?.supportsDeveloperRole === true,
      supportsTools: capabilities.tools,
      anthropicAuthMode: resolved.provider.type === "anthropic" && resolved.provider.authMode !== "oauth-bearer"
        ? "api-key"
        : "bearer",
      reasoningProtocol: profile.reasoningProtocol,
      providerOptions
    }),
    providerOptions,
    reasoning: enabled ? config.thinking.effort === "max" ? "xhigh" : config.thinking.effort : "off",
    timeoutMs: resolved.provider.timeoutMs,
    maxOutputTokens: resolved.model.maxOutputTokens,
    maxRetries: 0,
    contextWindow: resolved.model.contextWindow
  };
}

export function validateModelConfiguration(config: AgentConfig, alias = config.defaultModel): void {
  const resolved = resolveNativeModelConfig(config, alias);
  const profile = providerProfile(resolved.provider.type);
  const endpoint = resolved.model.baseUrl ?? resolved.provider.baseUrl ?? profile.baseUrl;
  if (!endpoint) throw new Error(`No model endpoint configured. Set providers.${resolved.providerAlias}.baseUrl.`);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid model endpoint for provider ${resolved.providerAlias}: ${endpoint}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Model endpoint for provider ${resolved.providerAlias} must use http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Model endpoint for provider ${resolved.providerAlias} must not contain credentials in the URL.`);
  }
  const apiKey = resolveApiKey(resolved.provider.apiKey, resolved.provider.apiKeyEnv, profile.apiKeyEnv);
  if ((resolved.provider.requiresApiKey ?? profile.requiresApiKey) && !apiKey) {
    throw new Error(missingKeyMessage(resolved.providerAlias, resolved.provider.apiKeyEnv, profile.apiKeyEnv));
  }
}

function resolveNativeModelConfig(config: AgentConfig, alias: string): { alias: string; model: ModelAliasConfig; providerAlias: string; provider: ProviderConfig } {
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown model alias: ${alias}`);
  const provider = config.providers[model.provider];
  if (!provider) throw new Error(`Unknown provider alias: ${model.provider}`);
  return { alias, model, providerAlias: model.provider, provider };
}

function nativeProtocolForModel(
  model: ModelAliasConfig,
  provider: ProviderConfig,
  profile: ReturnType<typeof providerProfile>
): "anthropic" | "openai-compatible" {
  if (model.apiBackend === "anthropic_messages") return "anthropic";
  if (model.apiBackend === "chat_completions") return "openai-compatible";
  return providerProtocol(provider, profile);
}

function resolveApiKey(configuredKey: string | undefined, configuredEnv: string | undefined, defaultEnv: string | undefined): string | undefined {
  if (configuredKey) return configuredKey;
  const envName = configuredEnv ?? defaultEnv;
  return envName ? process.env[envName] : undefined;
}

function missingKeyMessage(providerAlias: string, configuredEnv: string | undefined, defaultEnv: string | undefined): string {
  const envName = configuredEnv ?? defaultEnv;
  const credentialHint = process.platform === "darwin"
    ? `macOS Keychain 中的 provider:${providerAlias}:apiKey 或 ${envName ?? "配置的环境变量"}`
    : (envName ?? `providers.${providerAlias}.apiKeyEnv 环境变量`);
  return `No model available. Set ${credentialHint}.`;
}

function validateEndpointAndCredentials(
  providerAlias: string,
  provider: ProviderConfig,
  profile: ReturnType<typeof providerProfile>,
  endpoint: string,
  apiKey: string | undefined
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid model endpoint for provider ${providerAlias}: ${endpoint}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Model endpoint for provider ${providerAlias} must use http:// or https://.`);
  if (parsed.username || parsed.password) throw new Error(`Model endpoint for provider ${providerAlias} must not contain credentials in the URL.`);
  if ((provider.requiresApiKey ?? profile.requiresApiKey) && !apiKey) throw new Error(missingKeyMessage(providerAlias, provider.apiKeyEnv, profile.apiKeyEnv));
}

function mergeCompatibility(provider: ModelCompatibility | undefined, model: ModelCompatibility | undefined): ModelCompatibility | undefined {
  if (!provider && !model) return undefined;
  return { ...provider, ...model };
}

function createNativeProviderOptions(
  providerType: AgentConfig["providers"][string]["type"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, unknown> | undefined {
  if (mergeCompatibility(provider.compatibility, model.compatibility)?.supportsReasoning === false) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  const apiBackend: ModelApiBackend = model.apiBackend
    ?? provider.apiBackend
    ?? (providerType === "openai-codex"
      ? "responses"
      : provider.protocol === "anthropic" || providerType === "anthropic" || providerType === "claude-subscription"
        ? "anthropic_messages"
        : "chat_completions");
  if (apiBackend === "anthropic_messages") return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  if (providerType === "deepseek") return { deepseek: { thinking: { type: enabled ? "enabled" : "disabled" }, reasoningEffort: enabled ? nativeEffort : undefined } };
  if (providerType === "openai") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (providerType === "qwen") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (providerType === "kimi") {
    if (isKimiK3Model(model.model)) {
      // K3 cannot disable thinking. When the global switch is off, use the
      // lowest K3 effort instead of sending the unsupported thinking field.
      return { moonshotai: { reasoningEffort: enabled ? nativeEffort ?? "high" : "low" } };
    }
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled" } } };
  }
  return undefined;
}
