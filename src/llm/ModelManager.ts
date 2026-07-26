import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import {
  configSchema,
  type AgentConfig,
  type ReasoningEffort
} from "../config/schema.js";
import { createModelSettings, resolveModelConfig, type ModelSettings } from "./factory.js";
import { providerProfile } from "./profiles.js";
import type { LanguageModel } from "ai";
import { fetchModelCatalog } from "../ai/modelCatalog.js";
import { modelCapabilities, modelContextBudget, modelReasoningConfig } from "../ai/capabilities.js";
import { providerDefinition } from "../ai/provider.js";
import type { ModelCatalogEntry } from "../ai/types.js";

export type ThinkingSelection = "off" | ReasoningEffort;

export interface ModelChoice {
  alias: string;
  displayName: string;
  description?: string;
  provider: string;
  providerType: string;
  model: string;
  supportsTools?: boolean;
  capabilities?: ReturnType<typeof modelCapabilities>;
  contextWindow?: number;
  /** 单轮允许注入的输入 token 预算；界面用它做上下文用量的分母（运行时还没起来时也能算）。 */
  maxInputTokens?: number;
  efforts: ReasoningEffort[];
  defaultThinking: ThinkingSelection;
  /**
   * False when the alias is configured but its provider has no usable endpoint
   * or credential yet. Selecting it would fail on the first request, so every
   * surface either hides it (desktop) or marks it unusable (TUI / CLI).
   */
  available: boolean;
}

export interface ModelRuntimeInfo {
  modelAlias: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  thinking: ThinkingSelection;
  contextWindow?: number;
  maxInputTokens?: number;
}

/** Keeps one validated AI SDK model while the selected provider changes. */
export class ModelManager {
  private activeSettings: ModelSettings;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AgentConfig,
    private readonly configStore: AgentConfigStore = createFileConfigStore(workspaceRoot)
  ) {
    this.activeSettings = createModelSettings(config);
  }

  listModels(): ModelChoice[] {
    return listModelChoices(this.config);
  }

  getInfo(): ModelRuntimeInfo {
    return modelRuntimeInfo(this.config);
  }

  getModel(): LanguageModel {
    return this.activeSettings.model;
  }

  getModelSettings(): ModelSettings {
    return this.activeSettings;
  }

  getContextBudget(): ReturnType<typeof modelContextBudget> {
    const resolved = resolveModelConfig(this.config);
    return modelContextBudget(resolved.model, this.config.context.maxInputTokens, resolved.alias);
  }

  async refreshModelCatalog(providerAlias = resolveModelConfig(this.config).providerAlias): Promise<ModelCatalogEntry[]> {
    const provider = this.config.providers[providerAlias];
    if (!provider) throw new Error(`Unknown provider alias: ${providerAlias}`);
    return await fetchModelCatalog({
      alias: providerAlias,
      config: provider,
      definition: providerDefinition(provider.type)
    });
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    // 以盘上的配置为基准，而不是内存里的快照：同一份配置可能已被别的运行时改过
    // （桌面端多项目共用配置、权限模式变更、OAuth token 刷新等），整份写回内存快照会把那些
    // 改动覆盖掉。读不到就退回内存快照，行为与以前一致。
    const persisted = await this.configStore.load().catch(() => this.config);
    const model = persisted.models[alias];
    if (!model) throw new Error(`Unknown model alias: ${alias}`);
    const selection = resolveThinkingSelection(persisted, alias, thinking);
    const effort = selection === "off"
      ? model.thinking?.defaultEffort ?? persisted.thinking.effort
      : selection;
    const candidate = configSchema.parse({
      ...persisted,
      defaultModel: alias,
      thinking: { enabled: selection !== "off", effort }
    });

    // Validate endpoint and credentials before changing memory or the config file.
    const nextSettings = createModelSettings(candidate);
    await this.configStore.save(candidate);
    Object.assign(this.config, candidate);
    this.activeSettings = nextSettings;
    return this.getInfo();
  }

  async refreshFromDisk(): Promise<ModelRuntimeInfo> {
    const nextConfig = await this.configStore.load();
    const nextSettings = createModelSettings(nextConfig);
    Object.assign(this.config, nextConfig);
    this.activeSettings = nextSettings;
    return this.getInfo();
  }
}

export function listModelChoices(config: AgentConfig): ModelChoice[] {
  const entries = [
    ...Object.entries(config.models).filter(([alias]) => alias === config.defaultModel),
    ...Object.entries(config.models).filter(([alias]) => alias !== config.defaultModel)
  ];
  const seenModels = new Set<string>();
  return entries.flatMap(([alias, model]) => {
    const modelKey = `${model.provider}\u0000${model.model}`;
    if (seenModels.has(modelKey)) return [];
    seenModels.add(modelKey);
    const provider = config.providers[model.provider];
    const capabilities = modelCapabilities(model);
    const reasoning = modelReasoningConfig(model);
    return [{
      alias,
      displayName: model.displayName ?? model.model,
      description: model.description,
      provider: model.provider,
      providerType: provider?.type ?? model.provider,
      model: model.model,
      supportsTools: capabilities.tools,
      capabilities,
      contextWindow: model.contextWindow,
      maxInputTokens: modelContextBudget(model, config.context.maxInputTokens, alias).maxInputTokens,
      efforts: [...(reasoning?.efforts ?? [])],
      defaultThinking: reasoning?.defaultEffort ?? "off",
      available: hasUsableModelConfiguration(config, alias)
    }];
  });
}

export function listConfiguredModelChoices(config: AgentConfig): ModelChoice[] {
  return listModelChoices(config).filter((model) => model.available);
}

export function hasUsableModelConfiguration(config: AgentConfig, alias = config.defaultModel): boolean {
  const model = config.models[alias];
  const provider = model ? config.providers[model.provider] : undefined;
  if (!provider) return false;
  const profile = providerProfile(provider.type);
  const endpoint = provider.baseUrl ?? profile.baseUrl;
  if (!endpoint) return false;
  if (!(provider.requiresApiKey ?? profile.requiresApiKey)) return true;
  const envName = provider.apiKeyEnv ?? profile.apiKeyEnv;
  return Boolean(provider.apiKey || (envName && process.env[envName]));
}

export function modelRuntimeInfo(config: AgentConfig): ModelRuntimeInfo {
  const resolved = resolveModelConfig(config);
  const thinking: ThinkingSelection = config.thinking.enabled ? config.thinking.effort : "off";
  return {
    modelAlias: resolved.alias,
    provider: resolved.provider.type,
    modelLabel: formatModelLabel(resolved.provider.type, resolved.model.model),
    reasoningLabel: thinking === "off" ? "Off" : formatReasoningLabel(thinking),
    thinking,
    contextWindow: resolved.model.contextWindow,
    maxInputTokens: modelContextBudget(resolved.model, config.context.maxInputTokens, resolved.alias).maxInputTokens
  };
}

export function resolveThinkingSelection(
  config: AgentConfig,
  alias: string,
  requested?: ThinkingSelection
): ThinkingSelection {
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown model alias: ${alias}`);
  if (requested === undefined) {
    if (alias === config.defaultModel) return config.thinking.enabled ? config.thinking.effort : "off";
    return modelReasoningConfig(model)?.defaultEffort ?? "off";
  }
  if (requested === "off") return "off";
  if (!modelReasoningConfig(model)?.efforts.includes(requested)) {
    throw new Error(`Model ${alias} does not support ${requested} thinking effort.`);
  }
  return requested;
}

export function parseThinkingSelection(value: string | undefined): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized as ThinkingSelection;
  throw new Error(`Unknown thinking effort: ${value}. Use off, minimal, low, medium, high, xhigh, or max.`);
}

function formatReasoningLabel(thinking: Exclude<ThinkingSelection, "off">): string {
  return thinking === "xhigh" ? "XHigh" : thinking[0]?.toUpperCase() + thinking.slice(1);
}

function formatModelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}
