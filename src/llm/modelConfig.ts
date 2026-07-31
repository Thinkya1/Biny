import type { AgentConfig, ModelAliasConfig, ProviderConfig } from "../config/schema.js";

export interface ResolvedModelConfig {
  alias: string;
  model: ModelAliasConfig;
  providerAlias: string;
  provider: ProviderConfig;
}

export function resolveModelConfig(config: AgentConfig, alias = config.defaultModel): ResolvedModelConfig {
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown model alias: ${alias}`);
  const provider = config.providers[model.provider];
  if (!provider) throw new Error(`Unknown provider alias: ${model.provider}`);
  return { alias, model, providerAlias: model.provider, provider };
}
