import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import {
  configSchema,
  type AgentConfig,
  type ReasoningEffort
} from "../config/schema.js";
import {
  createModelSettings,
  resolveModelConfig,
  validateModelConfiguration,
  type ModelSettings
} from "./factory.js";
import type { LanguageModel } from "ai";
import { fetchModelCatalog } from "../ai/modelCatalog.js";
import { modelContextBudget, modelReasoningConfig, modelThinkingLevelMap } from "../ai/capabilities.js";
import { providerDefinition } from "../ai/provider.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import {
  hasUsableModelConfiguration as hasUsableRegisteredModel,
  ModelRegistry,
  type ModelChoice
} from "./ModelRegistry.js";
import { ModelResolver } from "./ModelResolver.js";
import { refreshSubscriptionOAuthTokens } from "./subscriptionAuth.js";

export type ThinkingSelection = "off" | ReasoningEffort;
export type { ModelChoice } from "./ModelRegistry.js";

const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1_000;

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
  private readonly registry: ModelRegistry;
  private observedConfigRevision: number | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AgentConfig,
    private readonly configStore: AgentConfigStore = createFileConfigStore(workspaceRoot)
  ) {
    this.registry = new ModelRegistry(config);
    this.activeSettings = createModelSettings(config);
    this.observedConfigRevision = configStore.revision?.();
  }

  listModels(): ModelChoice[] {
    return this.registry.listModels();
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

  /**
   * 所有 AgentSession 回合共用的轻量准备：进程内配置变更才重读磁盘，
   * 当前 OAuth provider 临近过期才联网续期，其余 prompt 只做同步配置校验。
   */
  async preparePrompt(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const revision = this.configStore.revision?.();
    if (revision !== undefined && revision !== this.observedConfigRevision) {
      await this.refreshFromDisk();
    }

    const resolved = resolveModelConfig(this.config);
    const oauth = resolved.provider.oauth;
    if (
      resolved.provider.authMode === "oauth-bearer"
      && oauth?.refreshToken
      && oauth.expiresAt - Date.now() <= OAUTH_REFRESH_WINDOW_MS
    ) {
      const refreshed = await refreshSubscriptionOAuthTokens(oauth.provider, {
        accessToken: resolved.provider.apiKey ?? "",
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        accountId: oauth.accountId
      }, signal);
      const nextConfig = configSchema.parse({
        ...this.config,
        providers: {
          ...this.config.providers,
          [resolved.providerAlias]: {
            ...resolved.provider,
            apiKey: refreshed.accessToken,
            oauth: {
              provider: oauth.provider,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
              accountId: refreshed.accountId
            }
          }
        }
      });
      await this.configStore.save(nextConfig, this.workspaceRoot);
      const effective = await this.configStore.load(this.workspaceRoot).catch(() => nextConfig);
      this.applyConfig(effective);
    }

    validateModelConfiguration(this.config);
  }

  async refreshModelCatalog(providerAlias = resolveModelConfig(this.config).providerAlias): Promise<ModelCatalogEntry[]> {
    const provider = this.config.providers[providerAlias];
    if (!provider) throw new Error(`Unknown provider alias: ${providerAlias}`);
    const entries = await fetchModelCatalog({
      alias: providerAlias,
      config: provider,
      definition: providerDefinition(provider.type)
    });
    this.registry.registerCatalog(providerAlias, entries);
    return entries;
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    // 以盘上的配置为基准，而不是内存里的快照：同一份配置可能已被别的运行时改过
    // （桌面端多项目共用配置、权限模式变更、OAuth token 刷新等），整份写回内存快照会把那些
    // 改动覆盖掉。读不到就退回内存快照，行为与以前一致。
    const persisted = await this.configStore.load(this.workspaceRoot).catch(() => this.config);
    const persistedRegistry = new ModelRegistry(persisted);
    for (const [providerAlias, entries] of this.registry.catalogsSnapshot()) persistedRegistry.registerCatalog(providerAlias, entries);
    // 解析允许先找到模型，再由 createModelSettings 给出具体的 endpoint/credential 错误；
    // 这样 CLI/TUI 不会把缺少哪个环境变量的信息吞掉。
    const resolved = new ModelResolver(persistedRegistry).resolve(alias);
    const modelAlias = resolved.alias;
    const model = resolved.model;
    const selection = resolveThinkingSelection({ ...persisted, models: { ...persisted.models, [modelAlias]: model } }, modelAlias, thinking);
    const effort = selection === "off"
      ? modelReasoningConfig(model)?.defaultEffort ?? persisted.thinking.effort
      : selection;
    const candidate = configSchema.parse({
      ...persisted,
      defaultModel: modelAlias,
      models: { ...persisted.models, [modelAlias]: model },
      thinking: { enabled: selection !== "off", effort }
    });

    // Validate endpoint and credentials before changing memory or the config file.
    const nextSettings = createModelSettings(candidate);
    await this.configStore.save(candidate, this.workspaceRoot);
    // 项目覆盖的 defaultModel/thinking 仍然优先；保存后重新读取有效配置，避免内存状态
    // 短暂显示一个实际上被项目覆盖遮住的模型。
    const effective = await this.configStore.load(this.workspaceRoot).catch(() => candidate);
    if (effective === candidate) {
      Object.assign(this.config, effective);
      this.activeSettings = nextSettings;
      this.observedConfigRevision = this.configStore.revision?.();
    } else {
      this.applyConfig(effective);
    }
    return this.getInfo();
  }

  async refreshFromDisk(): Promise<ModelRuntimeInfo> {
    const nextConfig = await this.configStore.load(this.workspaceRoot);
    this.applyConfig(nextConfig);
    return this.getInfo();
  }

  private applyConfig(nextConfig: AgentConfig): void {
    const nextSettings = createModelSettings(nextConfig);
    Object.assign(this.config, nextConfig);
    this.activeSettings = nextSettings;
    this.observedConfigRevision = this.configStore.revision?.();
  }
}

export function listModelChoices(config: AgentConfig): ModelChoice[] {
  return new ModelRegistry(config).listModels();
}

export function listConfiguredModelChoices(config: AgentConfig): ModelChoice[] {
  return listModelChoices(config).filter((model) => model.available);
}

export function hasUsableModelConfiguration(config: AgentConfig, alias = config.defaultModel): boolean {
  return hasUsableRegisteredModel(config, alias);
}

export function modelRuntimeInfo(config: AgentConfig): ModelRuntimeInfo {
  const resolved = resolveModelConfig(config);
  const reasoning = modelReasoningConfig(resolved.model);
  const thinking: ThinkingSelection = config.thinking.enabled && reasoning?.efforts.includes(config.thinking.effort)
    ? config.thinking.effort
    : "off";
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
    const reasoning = modelReasoningConfig(model);
    if (!reasoning) return "off";
    if (alias === config.defaultModel && config.thinking.enabled && reasoning.efforts.includes(config.thinking.effort)) {
      return config.thinking.effort;
    }
    return reasoning.defaultEffort;
  }
  const levelMap = modelThinkingLevelMap(model);
  if (requested === "off") {
    if (model.thinkingLevelMap && levelMap.off === undefined || levelMap.off === null) {
      throw new Error(`Model ${alias} does not support disabling thinking.`);
    }
    return "off";
  }
  if (levelMap[requested] === undefined || levelMap[requested] === null || !modelReasoningConfig(model)?.efforts.includes(requested)) {
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
