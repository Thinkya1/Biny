/**
 * AI 能力层共享类型。
 *
 * provider 定义、模型能力、上下文预算和模型目录条目的形状都在这里，`src/ai` 内各文件
 * 以及调用方都以这些类型为契约。
 */
import type { ModelApiBackend, ModelCompatibility, ModelProvider, ProviderConfig, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export type AiProtocol = "anthropic" | "openai-compatible";
export type AiAuthMode = "api-key" | "oauth-bearer";

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  streaming: boolean;
}

export interface ModelContextBudget {
  modelAlias?: string;
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number | undefined;
}

/**
 * 一个 provider 的接入方式：走哪种协议、默认 base URL、鉴权方式，以及思考内容用哪家的
 * 协议解析（各家 reasoning 字段并不通用）。
 */
export interface ProviderDefinition {
  type: ModelProvider;
  protocol: AiProtocol;
  baseUrl?: string;
  apiKeyEnv?: string;
  requiresApiKey: boolean;
  authModes: AiAuthMode[];
  reasoningProtocol?: "deepseek" | "openai" | "anthropic" | "alibaba" | "moonshotai";
}

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  capabilities: Partial<ModelCapabilities>;
  reasoningEfforts: ReasoningEffort[];
  thinkingLevelMap?: ThinkingLevelMap;
  apiBackend?: ModelApiBackend;
  baseUrl?: string;
  headers?: Record<string, string>;
  compatibility?: ModelCompatibility;
}

export interface CatalogProviderRequest {
  alias: string;
  config: ProviderConfig;
  definition: ProviderDefinition;
}
