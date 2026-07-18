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
}

/** Build the Vercel AI SDK model used by every runtime surface. */
export function createLanguageModelForConfig(config: AgentConfig, alias = config.defaultModel): LanguageModel {
  return createModelSettings(config, alias).model;
}

export function createModelSettings(config: AgentConfig, alias = config.defaultModel): ModelSettings {
  const resolved = resolveModelConfig(config, alias);
  const profile = providerProfile(resolved.provider.type);
  const apiKey = resolveApiKey(resolved.provider.apiKey, resolved.provider.apiKeyEnv, profile.apiKeyEnv);
  if (profile.requiresApiKey && !apiKey) {
    throw new Error(missingKeyMessage(resolved.providerAlias, resolved.provider.apiKeyEnv, profile.apiKeyEnv));
  }

  const baseUrl = resolved.provider.baseUrl ?? profile.baseUrl;
  if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${resolved.providerAlias}.baseUrl.`);

  return {
    model: createLanguageModel(resolved.provider.type, baseUrl, apiKey, resolved.model.model),
    providerOptions: createProviderOptions(resolved.provider.type, config),
    reasoning: config.thinking.enabled ? config.thinking.effort === "max" ? "xhigh" : "high" : "none",
    timeoutMs: resolved.provider.timeoutMs,
    maxOutputTokens: resolved.model.maxOutputTokens
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

function createLanguageModel(providerType: AgentConfig["providers"][string]["type"], baseUrl: string, apiKey: string | undefined, modelId: string): LanguageModel {
  if (providerType === "openai") return createOpenAI({ baseURL: baseUrl, apiKey }).chat(modelId);
  if (providerType === "anthropic") return createAnthropic({ baseURL: baseUrl, apiKey }).languageModel(modelId);
  if (providerType === "claude-subscription") {
    return createAnthropic({
      baseURL: baseUrl,
      authToken: apiKey,
      headers: claudeSubscriptionHeaders()
    }).languageModel(modelId);
  }
  if (providerType === "openai-codex") {
    return createOpenAI({
      baseURL: baseUrl,
      apiKey,
      headers: openAiCodexHeaders(apiKey)
    }).responses(modelId);
  }
  if (providerType === "deepseek") return createDeepSeek({ baseURL: baseUrl, apiKey }).languageModel(modelId);
  if (providerType === "kimi") return createMoonshotAI({ baseURL: baseUrl, apiKey }).languageModel(modelId);
  if (providerType === "qwen") return createAlibaba({ baseURL: baseUrl, apiKey }).languageModel(modelId);

  const compatible = createOpenAICompatible({
    name: providerType,
    baseURL: baseUrl,
    apiKey,
    includeUsage: true
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

function createProviderOptions(providerType: AgentConfig["providers"][string]["type"], config: AgentConfig): Record<string, any> | undefined {
  const enabled = config.thinking.enabled;
  const effort = config.thinking.effort;
  const budgetTokens = effort === "max" ? 8_192 : 4_096;
  if (providerType === "deepseek") {
    return {
      deepseek: {
        thinking: { type: enabled ? "enabled" : "disabled" },
        reasoningEffort: enabled ? effort : undefined
      }
    };
  }
  if (providerType === "openai" || providerType === "openai-codex") return { openai: { reasoningEffort: enabled ? effort : "none" } };
  if (providerType === "anthropic" || providerType === "claude-subscription") {
    return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  }
  if (providerType === "qwen") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (providerType === "kimi") {
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled", budgetTokens: enabled ? budgetTokens : undefined } } };
  }
  return undefined;
}
