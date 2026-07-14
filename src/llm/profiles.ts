import type { ModelProvider } from "../config/schema.js";

export type ProviderProtocol = "anthropic" | "openai-compatible";
export type ReasoningProtocol = "deepseek" | "openai" | "anthropic" | "alibaba" | "moonshotai";

export interface ProviderProfile {
  protocol: ProviderProtocol;
  baseUrl?: string;
  apiKeyEnv?: string;
  requiresApiKey: boolean;
  reasoningProtocol?: ReasoningProtocol;
}

const providerProfiles: Record<ModelProvider, ProviderProfile> = {
  deepseek: {
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    requiresApiKey: true,
    reasoningProtocol: "deepseek"
  },
  openai: {
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    requiresApiKey: true,
    reasoningProtocol: "openai"
  },
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    requiresApiKey: true,
    reasoningProtocol: "anthropic"
  },
  gemini: {
    protocol: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    requiresApiKey: true
  },
  kimi: {
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    requiresApiKey: true,
    reasoningProtocol: "moonshotai"
  },
  qwen: {
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    requiresApiKey: true,
    reasoningProtocol: "alibaba"
  },
  ollama: {
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false
  },
  "openai-compatible": {
    protocol: "openai-compatible",
    requiresApiKey: true
  }
};

export function providerProfile(provider: ModelProvider): ProviderProfile {
  return providerProfiles[provider];
}
