/**
 * LLM provider 工厂模块。
 *
 * 运行时解析 provider profile 和密钥来源，再创建对应协议 adapter。配置中的 apiKey
 * 优先于 apiKeyEnv；解析逻辑集中在这里，命令实现不需要关心具体模型厂商。
 */
import type { AgentConfig, ModelAliasConfig, ProviderConfig } from "../config/schema.js";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { modelCapabilities, nativeReasoningEffort, reasoningBudgetTokens } from "../ai/capabilities.js";
import { providerProtocol } from "../ai/provider.js";
import { createRetryFetch } from "../ai/retry.js";
import { providerProfile } from "./profiles.js";

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

  const baseUrl = resolved.provider.baseUrl ?? profile.baseUrl;
  if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${resolved.providerAlias}.baseUrl.`);
  const capabilities = modelCapabilities(resolved.model);
  const enabled = config.thinking.enabled && capabilities.reasoning;
  const effort = enabled ? config.thinking.effort : undefined;
  const retry = resolved.provider.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };

  return {
    model: createLanguageModel(resolved.provider.type, providerProtocol(resolved.provider, profile), baseUrl, apiKey, resolved.model.model, resolved.provider, createRetryFetch(retry)),
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

function resolveApiKey(configuredKey: string | undefined, configuredEnv: string | undefined, defaultEnv: string | undefined): string | undefined {
  if (configuredKey) return configuredKey;
  const envName = configuredEnv ?? defaultEnv;
  return envName ? process.env[envName] : undefined;
}

function missingKeyMessage(providerAlias: string, configuredEnv: string | undefined, defaultEnv: string | undefined): string {
  const envName = configuredEnv ?? defaultEnv;
  return envName
    ? `No model available. Set providers.${providerAlias}.apiKey or ${envName} in your environment.`
    : `No model available. Set providers.${providerAlias}.apiKey in agent.config.json.`;
}

function createLanguageModel(
  providerType: AgentConfig["providers"][string]["type"],
  protocol: "anthropic" | "openai-compatible",
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  provider: ProviderConfig,
  fetch: typeof globalThis.fetch
): LanguageModel {
  if (providerType === "openai") return createOpenAI({ baseURL: baseUrl, apiKey, fetch }).chat(modelId);
  if (providerType === "anthropic" || protocol === "anthropic" && providerType !== "claude-subscription") {
    return createAnthropic({ baseURL: baseUrl, apiKey, fetch }).languageModel(modelId);
  }
  if (providerType === "claude-subscription") {
    return createAnthropic({
      baseURL: baseUrl,
      authToken: apiKey,
      fetch,
      headers: claudeSubscriptionHeaders()
    }).languageModel(modelId);
  }
  if (providerType === "openai-codex") {
    return createOpenAI({
      baseURL: baseUrl,
      apiKey,
      fetch,
      headers: openAiCodexHeaders(apiKey)
    }).responses(modelId);
  }
  if (providerType === "deepseek") return createDeepSeek({ baseURL: baseUrl, apiKey, fetch }).languageModel(modelId);
  if (providerType === "kimi") return createMoonshotAI({ baseURL: baseUrl, apiKey, fetch }).languageModel(modelId);
  if (providerType === "qwen") return createAlibaba({ baseURL: baseUrl, apiKey, fetch }).languageModel(modelId);

  const compatible = createOpenAICompatible({
    name: providerType,
    baseURL: baseUrl,
    apiKey,
    fetch,
    includeUsage: true,
    transformRequestBody: createCompatibilityTransform(provider.compatibility)
  });
  return compatible.languageModel(modelId);
}

const CLAUDE_SUBSCRIPTION_BETA = "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219";

function claudeSubscriptionHeaders(): Record<string, string> {
  return {
    "User-Agent": "claude-cli/2.1.153 (external, cli)",
    "anthropic-beta": CLAUDE_SUBSCRIPTION_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli"
  };
}

function openAiCodexHeaders(accessToken: string | undefined): Record<string, string> {
  const accountId = accessToken ? extractOpenAiAccountId(accessToken) : undefined;
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (Biny)"
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function extractOpenAiAccountId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const nested = parsed["https://api.openai.com/auth"];
    if (nested && typeof nested === "object") {
      const accountId = (nested as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === "string" && accountId) return accountId;
    }
    const accountId = parsed.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function createProviderOptions(
  providerType: AgentConfig["providers"][string]["type"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, any> | undefined {
  if (provider.compatibility?.supportsReasoning === false) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  if (providerType === "deepseek") {
    return {
      deepseek: {
        thinking: { type: enabled ? "enabled" : "disabled" },
        reasoningEffort: enabled ? nativeEffort : undefined
      }
    };
  }
  if (providerType === "openai" || providerType === "openai-codex") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (provider.protocol === "anthropic" || providerType === "anthropic" || providerType === "claude-subscription") {
    return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  }
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
