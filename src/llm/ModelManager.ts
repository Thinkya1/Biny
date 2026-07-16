import { loadConfig, saveConfig } from "../config/loader.js";
import {
  configSchema,
  type AgentConfig,
  type ReasoningEffort
} from "../config/schema.js";
import { createModelSettings, resolveModelConfig, type ModelSettings } from "./factory.js";
import type { LanguageModel } from "ai";

export type ThinkingSelection = "off" | ReasoningEffort;

export interface ModelChoice {
  alias: string;
  displayName: string;
  description?: string;
  provider: string;
  providerType: string;
  model: string;
  supportsTools?: boolean;
  efforts: ReasoningEffort[];
  defaultThinking: ThinkingSelection;
}

export interface ModelRuntimeInfo {
  modelAlias: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  thinking: ThinkingSelection;
}

/** Keeps one validated AI SDK model while the selected provider changes. */
export class ModelManager {
  private activeSettings: ModelSettings;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AgentConfig
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

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const model = this.config.models[alias];
    if (!model) throw new Error(`Unknown model alias: ${alias}`);
    const selection = resolveThinkingSelection(this.config, alias, thinking);
    const effort = selection === "off"
      ? model.thinking?.defaultEffort ?? this.config.thinking.effort
      : selection;
    const candidate = configSchema.parse({
      ...this.config,
      defaultModel: alias,
      thinking: { enabled: selection !== "off", effort }
    });

    // Validate endpoint and credentials before changing memory or the config file.
    const nextSettings = createModelSettings(candidate);
    await saveConfig(this.workspaceRoot, candidate);
    Object.assign(this.config, candidate);
    this.activeSettings = nextSettings;
    return this.getInfo();
  }

  async refreshFromDisk(): Promise<ModelRuntimeInfo> {
    const nextConfig = await loadConfig(this.workspaceRoot);
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
    return [{
      alias,
      displayName: model.displayName ?? model.model,
      description: model.description,
      provider: model.provider,
      providerType: provider?.type ?? model.provider,
      model: model.model,
      supportsTools: model.supportsTools,
      efforts: [...(model.thinking?.efforts ?? [])],
      defaultThinking: model.thinking?.defaultEffort ?? "off"
    }];
  });
}

export function modelRuntimeInfo(config: AgentConfig): ModelRuntimeInfo {
  const resolved = resolveModelConfig(config);
  const thinking: ThinkingSelection = config.thinking.enabled ? config.thinking.effort : "off";
  return {
    modelAlias: resolved.alias,
    provider: resolved.provider.type,
    modelLabel: formatModelLabel(resolved.provider.type, resolved.model.model),
    reasoningLabel: thinking === "off" ? "Off" : thinking === "max" ? "Max" : "High",
    thinking
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
    return model.thinking?.defaultEffort ?? "off";
  }
  if (requested === "off") return "off";
  if (!model.thinking?.efforts.includes(requested)) {
    throw new Error(`Model ${alias} does not support ${requested} thinking effort.`);
  }
  return requested;
}

export function parseThinkingSelection(value: string | undefined): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "off" || normalized === "high" || normalized === "max") return normalized;
  throw new Error(`Unknown thinking effort: ${value}. Use off, high, or max.`);
}

function formatModelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}
