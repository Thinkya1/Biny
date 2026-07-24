import type { ModelProvider, ProviderConfig, ReasoningEffort } from "../config/schema.js";

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
}

export interface CatalogProviderRequest {
  alias: string;
  config: ProviderConfig;
  definition: ProviderDefinition;
}
