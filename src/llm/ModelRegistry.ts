/**
 * 统一模型注册表。
 *
 * 配置模型是稳定来源，provider `/models` 是可刷新来源。两者在这里合并成同一份模型视图；
 * 注册表只保存模型元数据，不保存 API key，也不会把实时目录自动写回项目配置。
 */
import { modelCapabilities, modelContextBudget, modelReasoningConfig, modelThinkingLevelMap } from "../ai/capabilities.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import type {
  AgentConfig,
  ModelAliasConfig,
  ModelApiBackend,
  ModelCompatibility,
  ModelProvider,
  ReasoningEffort,
  ThinkingLevelMap
} from "../config/schema.js";
import { providerDefinition } from "../ai/provider.js";
import { ProviderRegistry } from "./ProviderRuntime.js";

export type ModelSource = "configured" | "catalog";

export interface ModelChoice {
  alias: string;
  displayName: string;
  description?: string;
  provider: string;
  providerType: ModelProvider | string;
  model: string;
  modelKey: string;
  supportsTools?: boolean;
  capabilities?: ReturnType<typeof modelCapabilities>;
  contextWindow?: number;
  maxInputTokens?: number;
  efforts: ReasoningEffort[];
  defaultThinking: "off" | ReasoningEffort;
  thinkingLevelMap: ThinkingLevelMap;
  apiBackend?: ModelApiBackend;
  baseUrl?: string;
  compatibility?: ModelCompatibility;
  available: boolean;
  source: ModelSource;
}

export interface RegisteredModel {
  alias: string;
  model: ModelAliasConfig;
  providerAlias: string;
  source: ModelSource;
}

export function catalogModelAlias(providerAlias: string, modelId: string): string {
  return `${providerAlias}/${modelId}`;
}

export class ModelRegistry {
  private readonly catalogs = new Map<string, ModelCatalogEntry[]>();

  constructor(
    private readonly config: AgentConfig,
    private readonly providers: ProviderRegistry = new ProviderRegistry(config)
  ) {}

  registerCatalog(providerAlias: string, entries: ModelCatalogEntry[]): void {
    this.catalogs.set(providerAlias, entries.map((entry) => ({ ...entry, provider: providerAlias })));
  }

  catalog(providerAlias: string): ModelCatalogEntry[] {
    return [...(this.catalogs.get(providerAlias) ?? [])];
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return [...this.catalogs.entries()].map(([alias, entries]) => [alias, [...entries]]);
  }

  listModels(): ModelChoice[] {
    const choices: ModelChoice[] = [];
    const configuredKeys = new Set<string>();
    const aliases = [
      ...Object.keys(this.config.models).filter((alias) => alias === this.config.defaultModel),
      ...Object.keys(this.config.models).filter((alias) => alias !== this.config.defaultModel)
    ];

    for (const alias of aliases) {
      const model = this.config.models[alias];
      if (!model) continue;
      if (configuredKeys.has(modelKey(model.provider, model.model))) continue;
      configuredKeys.add(modelKey(model.provider, model.model));
      choices.push(this.toChoice(alias, model, "configured"));
    }

    for (const [providerAlias, entries] of this.catalogs) {
      for (const entry of entries) {
        if (configuredKeys.has(modelKey(providerAlias, entry.id))) continue;
        const alias = catalogModelAlias(providerAlias, entry.id);
        choices.push(this.toChoice(alias, catalogEntryToModel(entry), "catalog"));
      }
    }
    return choices;
  }

  listAvailableModels(): ModelChoice[] {
    return this.listModels().filter((choice) => choice.available);
  }

  isAvailable(resolved: RegisteredModel): boolean {
    return this.providers.get(resolved.providerAlias)?.isConfigured(resolved.model) ?? false;
  }

  resolve(aliasOrReference: string): RegisteredModel | undefined {
    const configured = this.config.models[aliasOrReference];
    if (configured) return { alias: aliasOrReference, model: configured, providerAlias: configured.provider, source: "configured" };

    const exactAlias = this.config.models[aliasOrReference.toLowerCase()];
    if (exactAlias) return { alias: aliasOrReference.toLowerCase(), model: exactAlias, providerAlias: exactAlias.provider, source: "configured" };

    const slash = aliasOrReference.indexOf("/");
    if (slash > 0) {
      const providerAlias = aliasOrReference.slice(0, slash);
      const modelId = aliasOrReference.slice(slash + 1);
      const configuredEntry = Object.entries(this.config.models).find(([, model]) => (
        model.provider === providerAlias && model.model === modelId
      ));
      if (configuredEntry) {
        return { alias: configuredEntry[0], model: configuredEntry[1], providerAlias, source: "configured" };
      }
      const catalogEntry = this.catalogs.get(providerAlias)?.find((entry) => entry.id === modelId);
      if (catalogEntry) {
        return {
          alias: catalogModelAlias(providerAlias, modelId),
          model: catalogEntryToModel(catalogEntry),
          providerAlias,
          source: "catalog"
        };
      }
    }

    for (const [providerAlias, entries] of this.catalogs) {
      const entry = entries.find((candidate) => catalogModelAlias(providerAlias, candidate.id) === aliasOrReference);
      if (entry) return { alias: catalogModelAlias(providerAlias, entry.id), model: catalogEntryToModel(entry), providerAlias, source: "catalog" };
    }
    return undefined;
  }

  private toChoice(alias: string, model: ModelAliasConfig, source: ModelSource): ModelChoice {
    const provider = this.config.providers[model.provider];
    const providerRuntime = this.providers.get(model.provider);
    const capabilities = modelCapabilities(model);
    const reasoning = modelReasoningConfig(model);
    const thinkingLevelMap = modelThinkingLevelMap(model);
    return {
      alias,
      displayName: model.displayName ?? model.model,
      description: model.description,
      provider: model.provider,
      providerType: provider?.type ?? model.provider,
      model: model.model,
      modelKey: modelKey(model.provider, model.model),
      supportsTools: capabilities.tools,
      capabilities,
      contextWindow: model.contextWindow,
      maxInputTokens: modelContextBudget(model, this.config.context.maxInputTokens, alias).maxInputTokens,
      efforts: [...(reasoning?.efforts ?? [])],
      defaultThinking: reasoning?.defaultEffort ?? "off",
      thinkingLevelMap,
      apiBackend: model.apiBackend,
      baseUrl: model.baseUrl ?? provider?.baseUrl ?? providerRuntime?.definition.baseUrl ?? (provider ? providerDefinition(provider.type).baseUrl : undefined),
      compatibility: model.compatibility ?? provider?.compatibility,
      available: providerRuntime?.isConfigured(model) ?? false,
      source
    };
  }
}

export function modelKey(providerAlias: string, modelId: string): string {
  return `${providerAlias}\u0000${modelId}`;
}

export function hasUsableModelConfiguration(config: AgentConfig, alias: string, modelOverride?: ModelAliasConfig): boolean {
  const model = modelOverride ?? config.models[alias];
  if (!model) return false;
  return new ProviderRegistry(config).get(model.provider)?.isConfigured(model) ?? false;
}

function catalogEntryToModel(entry: ModelCatalogEntry): ModelAliasConfig {
  const levelMap = entry.thinkingLevelMap ?? reasoningEffortsToMap(entry.reasoningEfforts);
  return {
    provider: entry.provider,
    model: entry.id,
    displayName: entry.displayName,
    capabilities: entry.capabilities,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    apiBackend: entry.apiBackend,
    baseUrl: entry.baseUrl,
    headers: entry.headers,
    compatibility: entry.compatibility,
    thinkingLevelMap: levelMap
  };
}

function reasoningEffortsToMap(efforts: ReasoningEffort[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = { off: "none" };
  for (const effort of efforts) map[effort] = effort;
  return map;
}
