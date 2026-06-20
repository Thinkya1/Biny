import type { AgentConfig } from "../config/schema.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./provider.js";

export function createLLMProvider(config: AgentConfig): LLMProvider {
  if (config.model.provider === "mock") return new MockProvider();

  const apiKey = process.env[config.model.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing model API key. Set ${config.model.apiKeyEnv} in your environment.`);
  }

  return new OpenAICompatibleProvider({
    baseUrl: config.model.baseUrl,
    model: config.model.model,
    apiKey
  });
}
