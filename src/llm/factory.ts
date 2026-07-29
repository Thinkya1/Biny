/**
 * LLM provider 工厂模块。
 *
 * 运行时解析 provider profile 和密钥来源，再创建对应协议 adapter。配置中的 apiKey
 * 优先于 apiKeyEnv；解析逻辑集中在这里，命令实现不需要关心具体模型厂商。
 */
import type { AgentConfig, ModelAliasConfig, ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { modelCapabilities, modelReasoningConfig, nativeReasoningEffort, reasoningBudgetTokens } from "../ai/capabilities.js";
import { providerProtocol } from "../ai/provider.js";
import { createRetryFetch } from "../ai/retry.js";
import { providerProfile } from "./profiles.js";
import { CLAUDE_SUBSCRIPTION_BETA, openAiCodexHeaders } from "./subscriptionAuth.js";

export interface ResolvedModelConfig {
  alias: string;
  model: ModelAliasConfig;
  providerAlias: string;
  provider: ProviderConfig;
}

export interface ModelSettings {
  model: LanguageModel;
  providerOptions?: Record<string, any>;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxRetries: number;
  contextWindow: number | undefined;
}

/** Build the Vercel AI SDK model used by every runtime surface. */
export function createLanguageModelForConfig(config: AgentConfig, alias = config.defaultModel): LanguageModel {
  return createModelSettings(config, alias).model;
}

export function createModelSettings(config: AgentConfig, alias = config.defaultModel): ModelSettings {
  const resolved = resolveModelConfig(config, alias);
  const profile = providerProfile(resolved.provider.type);
  const apiKey = resolveApiKey(resolved.provider.apiKey, resolved.provider.apiKeyEnv, profile.apiKeyEnv);
  if ((resolved.provider.requiresApiKey ?? profile.requiresApiKey) && !apiKey) {
    throw new Error(missingKeyMessage(resolved.providerAlias, resolved.provider.apiKeyEnv, profile.apiKeyEnv));
  }

  const baseUrl = resolved.model.baseUrl ?? resolved.provider.baseUrl ?? profile.baseUrl;
  if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${resolved.providerAlias}.baseUrl.`);
  validateEndpointAndCredentials(resolved.providerAlias, resolved.provider, profile, baseUrl, apiKey);
  const capabilities = modelCapabilities(resolved.model);
  const enabled = config.thinking.enabled && capabilities.reasoning && modelReasoningConfig(resolved.model) !== undefined;
  const effort = enabled ? config.thinking.effort : undefined;
  const retry = resolved.provider.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };

  return {
    model: createLanguageModel(resolved.provider.type, providerProtocolForModel(resolved.model, resolved.provider, profile), baseUrl, apiKey, resolved.model.model, resolved.provider, resolved.model, createRetryFetch(retry)),
    providerOptions: createProviderOptions(resolved.provider.type, resolved.provider, resolved.model, enabled, effort),
    reasoning: enabled ? effort === "max" ? "xhigh" : effort : "none",
    timeoutMs: resolved.provider.timeoutMs,
    maxOutputTokens: resolved.model.maxOutputTokens,
    // HTTP retries are performed by the provider fetch wrapper below. Keep
    // AI SDK-level retries disabled to avoid multiplying attempts.
    maxRetries: 0,
    contextWindow: resolved.model.contextWindow
  };
}

export function resolveModelConfig(config: AgentConfig, alias = config.defaultModel): ResolvedModelConfig {
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown model alias: ${alias}`);
  const provider = config.providers[model.provider];
  if (!provider) throw new Error(`Unknown provider alias: ${model.provider}`);
  return { alias, model, providerAlias: model.provider, provider };
}

/** 切换模型前使用的同步配置校验；真正发请求的连接测试由 Desktop 单独执行。 */
export function validateModelConfiguration(config: AgentConfig, alias = config.defaultModel): void {
  const resolved = resolveModelConfig(config, alias);
  const profile = providerProfile(resolved.provider.type);
  const apiKey = resolveApiKey(resolved.provider.apiKey, resolved.provider.apiKeyEnv, profile.apiKeyEnv);
  validateEndpointAndCredentials(
    resolved.providerAlias,
    resolved.provider,
    profile,
    resolved.model.baseUrl ?? resolved.provider.baseUrl ?? profile.baseUrl,
    apiKey
  );
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
  return envName
    ? `No model available. Set ${credentialHint}.`
    : `No model available. Set ${credentialHint}.`;
}

function createLanguageModel(
  providerType: AgentConfig["providers"][string]["type"],
  protocol: "anthropic" | "openai-compatible",
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  provider: ProviderConfig,
  model: ModelAliasConfig,
  fetch: typeof globalThis.fetch
): LanguageModel {
  const compatibility = mergeCompatibility(provider.compatibility, model.compatibility);
  const apiBackend = model.apiBackend
    ?? provider.apiBackend
    ?? (providerType === "openai-codex" ? "responses" : protocol === "anthropic" ? "anthropic_messages" : "chat_completions");
  const context: ProviderAdapterContext = {
    providerType,
    protocol,
    apiBackend,
    baseUrl,
    apiKey,
    modelId,
    provider,
    model,
    headers: model.headers,
    compatibility,
    fetch
  };
  const adapter = providerAdapters.find((candidate) => candidate.matches(context));
  if (!adapter) throw new Error(`No provider adapter for ${providerType}/${apiBackend}.`);
  return adapter.create(context);
}

interface ProviderAdapterContext {
  providerType: AgentConfig["providers"][string]["type"];
  protocol: "anthropic" | "openai-compatible";
  apiBackend: ModelApiBackend;
  baseUrl: string;
  apiKey: string | undefined;
  modelId: string;
  provider: ProviderConfig;
  model: ModelAliasConfig;
  headers: Record<string, string> | undefined;
  compatibility: ModelCompatibility | undefined;
  fetch: typeof globalThis.fetch;
}

export interface ProviderAdapter {
  readonly name: string;
  matches(context: ProviderAdapterContext): boolean;
  create(context: ProviderAdapterContext): LanguageModel;
}

const providerAdapters: ProviderAdapter[] = [
  {
    name: "anthropic-messages",
    matches: ({ providerType, apiBackend }) => apiBackend === "anthropic_messages" && providerType !== "claude-subscription",
    create: (context) => createAnthropic({
      baseURL: context.baseUrl,
      apiKey: context.apiKey,
      fetch: context.fetch,
      headers: context.headers
    }).languageModel(context.modelId)
  },
  {
    name: "claude-subscription",
    matches: ({ providerType }) => providerType === "claude-subscription",
    create: (context) => createAnthropic({
      baseURL: context.baseUrl,
      authToken: context.apiKey,
      fetch: context.fetch,
      headers: { ...claudeSubscriptionHeaders(), ...context.headers }
    }).languageModel(context.modelId)
  },
  {
    name: "openai-responses",
    matches: ({ apiBackend }) => apiBackend === "responses",
    create: (context) => createOpenAI({
      baseURL: context.baseUrl,
      apiKey: context.apiKey,
      fetch: context.fetch,
      headers: context.providerType === "openai-codex"
        ? { ...openAiCodexHeaders(context.apiKey), ...context.headers }
        : context.headers
    }).responses(context.modelId)
  },
  {
    name: "deepseek",
    matches: ({ providerType, apiBackend }) => providerType === "deepseek" && apiBackend === "chat_completions",
    create: (context) => createDeepSeek({ ...baseProviderOptions(context) }).languageModel(context.modelId)
  },
  {
    name: "moonshotai",
    matches: ({ providerType, apiBackend }) => providerType === "kimi" && apiBackend === "chat_completions",
    create: (context) => createMoonshotAI({ ...baseProviderOptions(context) }).languageModel(context.modelId)
  },
  {
    name: "alibaba",
    matches: ({ providerType, apiBackend }) => providerType === "qwen" && apiBackend === "chat_completions",
    create: (context) => createAlibaba({ ...baseProviderOptions(context) }).languageModel(context.modelId)
  },
  {
    name: "openai-chat",
    matches: ({ providerType, apiBackend }) => providerType === "openai" && apiBackend === "chat_completions",
    create: (context) => createOpenAI({ ...baseProviderOptions(context) }).chat(context.modelId)
  },
  {
    name: "openai-compatible",
    matches: ({ apiBackend }) => apiBackend === "chat_completions",
    create: (context) => createOpenAICompatible({
      name: context.providerType,
      ...baseProviderOptions(context),
      includeUsage: true,
      transformRequestBody: createCompatibilityTransform(context.compatibility)
    }).languageModel(context.modelId)
  }
];

function baseProviderOptions(context: ProviderAdapterContext): {
  baseURL: string;
  apiKey: string | undefined;
  fetch: typeof globalThis.fetch;
  headers?: Record<string, string>;
} {
  return {
    baseURL: context.baseUrl,
    apiKey: context.apiKey,
    fetch: context.fetch,
    headers: context.headers
  };
}

function providerProtocolForModel(
  model: ModelAliasConfig,
  provider: ProviderConfig,
  profile: ReturnType<typeof providerProfile>
): "anthropic" | "openai-compatible" {
  if (model.apiBackend === "anthropic_messages") return "anthropic";
  if (model.apiBackend === "chat_completions" || model.apiBackend === "responses") return "openai-compatible";
  return providerProtocol(provider, profile);
}

function mergeCompatibility(
  provider: ModelCompatibility | undefined,
  model: ModelCompatibility | undefined
): ModelCompatibility | undefined {
  if (!provider && !model) return undefined;
  return { ...provider, ...model };
}

function validateEndpointAndCredentials(
  providerAlias: string,
  provider: ProviderConfig,
  profile: ReturnType<typeof providerProfile>,
  endpoint: string | undefined,
  apiKey: string | undefined
): void {
  if (!endpoint) throw new Error(`No model endpoint configured. Set providers.${providerAlias}.baseUrl.`);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid model endpoint for provider ${providerAlias}: ${endpoint}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Model endpoint for provider ${providerAlias} must use http:// or https://.`);
  }
  if (parsed.username || parsed.password) throw new Error(`Model endpoint for provider ${providerAlias} must not contain credentials in the URL.`);
  if ((provider.requiresApiKey ?? profile.requiresApiKey) && !apiKey) {
    throw new Error(missingKeyMessage(providerAlias, provider.apiKeyEnv, profile.apiKeyEnv));
  }
}

function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    "User-Agent": "claude-cli/2.1.153 (external, cli)",
    "anthropic-beta": CLAUDE_SUBSCRIPTION_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli"
  };
}

function createProviderOptions(
  providerType: AgentConfig["providers"][string]["type"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, any> | undefined {
  if (mergeCompatibility(provider.compatibility, model.compatibility)?.supportsReasoning === false) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  const apiBackend = model.apiBackend
    ?? provider.apiBackend
    ?? (providerType === "openai-codex" ? "responses" : provider.protocol === "anthropic" || providerType === "anthropic" || providerType === "claude-subscription" ? "anthropic_messages" : "chat_completions");
  if (apiBackend === "anthropic_messages") {
    return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  }
  if (apiBackend === "responses") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (providerType === "deepseek") {
    return {
      deepseek: {
        thinking: { type: enabled ? "enabled" : "disabled" },
        reasoningEffort: enabled ? nativeEffort : undefined
      }
    };
  }
  if (providerType === "openai") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (providerType === "qwen") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (providerType === "kimi") {
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled", budgetTokens: enabled ? budgetTokens : undefined } } };
  }
  return undefined;
}

function createCompatibilityTransform(
  compatibility: ProviderConfig["compatibility"]
): ((body: Record<string, any>) => Record<string, any>) | undefined {
  if (!compatibility?.supportsDeveloperRole && compatibility?.maxTokensField !== "max_completion_tokens") return undefined;
  return (body) => {
    const messages = compatibility.supportsDeveloperRole === false && Array.isArray(body.messages)
      ? body.messages.map((message: any) => message?.role === "developer" ? { ...message, role: "system" } : message)
      : body.messages;
    if (compatibility.maxTokensField !== "max_completion_tokens") return { ...body, messages };
    const { max_tokens, ...rest } = body;
    return { ...rest, messages, max_tokens: undefined, max_completion_tokens: max_tokens };
  };
}
