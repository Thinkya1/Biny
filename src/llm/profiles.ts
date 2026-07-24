import type { ModelProvider } from "../config/schema.js";
import { providerDefinition } from "../ai/provider.js";
import type { ProviderDefinition } from "../ai/types.js";

/** @deprecated Use the provider definition from src/ai for new integrations. */
export type ProviderProtocol = "anthropic" | "openai-compatible";
export type ReasoningProtocol = NonNullable<ProviderDefinition["reasoningProtocol"]>;
export type ProviderProfile = ProviderDefinition;

export function providerProfile(provider: ModelProvider): ProviderProfile {
  return providerDefinition(provider);
}
