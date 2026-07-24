import type { ModelProvider, ProviderConfig } from "../config/schema.js";
import type { ProviderDefinition } from "./types.js";

const definitions: Record<ModelProvider, ProviderDefinition> = {
  deepseek: {
    type: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"],
    reasoningProtocol: "deepseek"
  },
  openai: {
    type: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"],
    reasoningProtocol: "openai"
  },
  anthropic: {
    type: "anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"],
    reasoningProtocol: "anthropic"
  },
  "claude-subscription": {
    type: "claude-subscription",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    authModes: ["oauth-bearer"],
    reasoningProtocol: "anthropic"
  },
  "openai-codex": {
    type: "openai-codex",
    protocol: "openai-compatible",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    requiresApiKey: true,
    authModes: ["oauth-bearer"],
    reasoningProtocol: "openai"
  },
  gemini: {
    type: "gemini",
    protocol: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"]
  },
  kimi: {
    type: "kimi",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"],
    reasoningProtocol: "moonshotai"
  },
  qwen: {
    type: "qwen",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    requiresApiKey: true,
    authModes: ["api-key"],
    reasoningProtocol: "alibaba"
  },
  ollama: {
    type: "ollama",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
    authModes: ["api-key"]
  },
  "openai-compatible": {
    type: "openai-compatible",
    protocol: "openai-compatible",
    requiresApiKey: true,
    authModes: ["api-key"]
  }
};

export function providerDefinition(type: ModelProvider): ProviderDefinition {
  return definitions[type];
}

export function providerProtocol(config: ProviderConfig, definition: ProviderDefinition): ProviderDefinition["protocol"] {
  return config.protocol ?? definition.protocol;
}
