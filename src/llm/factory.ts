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

function createProviderOptions(providerType: AgentConfig["providers"][string]["type"], config: AgentConfig): Record<string, any> | undefined {
  if (providerType !== "deepseek") return undefined;
  return {
    deepseek: {
      thinking: { type: config.thinking.enabled ? "enabled" : "disabled" },
      reasoningEffort: config.thinking.enabled ? config.thinking.effort : undefined
    }
  };
}
