/**
 * Provider 运行时。
 *
 * 每个配置别名对应一个实例，统一持有服务商默认值、鉴权、模型目录和请求准备逻辑。
 * API 协议的 HTTP/SSE 实现由 ApiAdapterRegistry 负责，两层不互相冒充。
 */
import type { AgentModel, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../agent/core/types.js";
import { isKimiK3Model, modelCapabilities, modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort, reasoningBudgetTokens } from "../ai/capabilities.js";
import { fetchModelCatalogSnapshot } from "../ai/modelCatalog.js";
import { providerDefinition, providerProtocol } from "../ai/provider.js";
import { createRetryFetch } from "../ai/retry.js";
import type { ModelCatalogEntry, ProviderDefinition } from "../ai/types.js";
import type { AgentConfig, ModelAliasConfig, ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";
import { createNativeModel } from "./nativeModel.js";
import { openAiCodexHeaders, refreshSubscriptionOAuthTokens } from "./subscriptionAuth.js";
import { AiRegistry } from "./AiRegistry.js";
import type { ModelsStore } from "./ModelsStore.js";

const oauthRefreshWindowMs = 5 * 60 * 1_000;

export interface NativeModelSettings {
  model: AgentModel;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | AgentConfig["thinking"]["effort"];
  timeoutMs?: number;
  maxOutputTokens?: number;
  contextWindow: number | undefined;
}

export interface ProviderRuntime {
  readonly id: string;
  readonly definition: ProviderDefinition;
  readonly config: ProviderConfig;
  getModels(): ModelCatalogEntry[];
  restoreModels(models: readonly ModelCatalogEntry[]): void;
  refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  isConfigured(model?: ModelAliasConfig): boolean;
  validate(model?: ModelAliasConfig): void;
  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): NativeModelSettings;
  streamSimple(
    agentConfig: AgentConfig,
    model: ModelAliasConfig,
    context: ModelStreamContext,
    options?: ModelStreamOptions
  ): Promise<AsyncIterable<ModelStreamEvent>>;
  refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined>;
}

export class ConfiguredProviderRuntime implements ProviderRuntime {
  readonly definition: ProviderDefinition;
  private readonly baselineModels: ModelCatalogEntry[];
  private liveModels: ModelCatalogEntry[] = [];

  constructor(
    readonly id: string,
    readonly config: ProviderConfig,
    private readonly ai: AiRegistry,
    baselineModels: readonly ModelCatalogEntry[] = [],
    private readonly modelsStore?: ModelsStore
  ) {
    this.definition = providerDefinition(config.type, ai.providers);
    this.baselineModels = baselineModels.map((model) => ({ ...model, provider: id }));
  }

  getModels(): ModelCatalogEntry[] {
    const combined = new Map(this.baselineModels.map((model) => [model.id, model]));
    for (const model of this.liveModels) combined.set(model.id, model);
    const models = [...combined.values()];
    try {
      const filtered = this.definition.filterModels?.(models, {
        configured: this.isConfigured(),
        authMode: this.config.authMode ?? this.definition.authModes[0]
      }) ?? models;
      return [...filtered].map((model) => ({ ...model }));
    } catch {
      // 一个扩展过滤器异常不能让整个模型菜单消失，退回完整目录。
      return models.map((model) => ({ ...model }));
    }
  }

  restoreModels(models: readonly ModelCatalogEntry[]): void {
    this.liveModels = models.map((model) => ({ ...model, provider: this.id }));
  }

  async refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    signal?.throwIfAborted();
    const cached = await this.modelsStore?.read(this.id).catch(() => undefined);
    let models: readonly ModelCatalogEntry[];
    let etag = cached?.etag;
    let lastModified = cached?.lastModified;
    if (this.definition.fetchModels) {
      models = await this.definition.fetchModels({ providerAlias: this.id, config: this.config, signal });
      etag = undefined;
      lastModified = undefined;
    } else {
      const result = await fetchModelCatalogSnapshot(
        { alias: this.id, config: this.config, definition: this.definition },
        signal,
        { etag: cached?.etag, lastModified: cached?.lastModified }
      );
      if (result.notModified && !cached) throw new Error(`Provider ${this.id} returned 304 without a stored model catalog.`);
      models = result.notModified ? cached!.models : result.models ?? [];
      etag = result.etag;
      lastModified = result.lastModified;
    }
    signal?.throwIfAborted();
    this.restoreModels(models);
    await this.modelsStore?.write(this.id, {
      models: this.liveModels,
      checkedAt: Date.now(),
      etag,
      lastModified
    }).catch(() => undefined);
    return this.getModels();
  }

  isConfigured(model?: ModelAliasConfig): boolean {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint || !isHttpEndpoint(endpoint)) return false;
    if (!(this.config.requiresApiKey ?? this.definition.requiresApiKey)) return true;
    return this.resolveApiKey() !== undefined;
  }

  validate(model?: ModelAliasConfig): void {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(`Invalid model endpoint for provider ${this.id}: ${endpoint}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Model endpoint for provider ${this.id} must use http:// or https://.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Model endpoint for provider ${this.id} must not contain credentials in the URL.`);
    }
    if ((this.config.requiresApiKey ?? this.definition.requiresApiKey) && !this.resolveApiKey()) {
      throw new Error(missingKeyMessage(this.id, this.config.apiKeyEnv, this.definition.apiKeyEnv));
    }
  }

  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): NativeModelSettings {
    this.validate(model);
    const apiKey = this.resolveApiKey();
    const baseUrl = model.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    const protocol = nativeProtocolForModel(model, this.config, this.definition);
    const api = model.apiBackend
      ?? this.config.apiBackend
      ?? this.definition.api
      ?? (this.config.type === "openai-codex"
        ? "responses"
        : protocol === "anthropic" ? "anthropic_messages" : "chat_completions");
    const capabilities = modelCapabilities(model);
    const enabled = agentConfig.thinking.enabled && capabilities.reasoning && modelReasoningConfig(model) !== undefined;
    const effort = enabled ? agentConfig.thinking.effort : undefined;
    const retry = this.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    const compatibility = mergeCompatibility(this.config.compatibility, model.compatibility);
    const providerOptions = createProviderOptions(this.config.type, this.config, model, enabled, effort);

    const transport = createNativeModel({
      provider: this.config.type,
      modelId: model.model,
      api,
      baseUrl,
      apiKey,
      headers: {
        ...(this.config.type === "openai-codex" ? openAiCodexHeaders(apiKey) : {}),
        ...this.config.headers,
        ...model.headers
      },
      fetch: createRetryFetch(retry),
      maxTokensField: compatibility?.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
      supportsDeveloperRole: compatibility?.supportsDeveloperRole === true,
      supportsTools: capabilities.tools,
      anthropicAuthMode: this.config.type === "anthropic" && this.config.authMode !== "oauth-bearer" ? "api-key" : "bearer",
      reasoningProtocol: this.definition.reasoningProtocol,
      providerOptions,
      apiAdapters: this.ai.adapters
    });
    const executable: AgentModel = {
      ...transport,
      streamSimple: async (context, options) => await this.streamSimple(agentConfig, model, context, options)
    };
    return {
      model: executable,
      providerOptions,
      reasoning: enabled ? agentConfig.thinking.effort : "off",
      timeoutMs: this.config.timeoutMs,
      maxOutputTokens: model.maxOutputTokens,
      contextWindow: model.contextWindow
    };
  }

  async streamSimple(
    agentConfig: AgentConfig,
    model: ModelAliasConfig,
    context: ModelStreamContext,
    options: ModelStreamOptions = {}
  ): Promise<AsyncIterable<ModelStreamEvent>> {
    const thinking = resolveSimpleThinking(agentConfig, model, options.reasoning);
    const settings = this.createModelSettings({ ...agentConfig, thinking }, model);
    return await settings.model.stream(context, {
      signal: options.signal,
      maxOutputTokens: options.maxOutputTokens ?? settings.maxOutputTokens,
      reasoning: settings.reasoning,
      providerOptions: options.providerOptions ?? settings.providerOptions,
      timeoutMs: options.timeoutMs ?? settings.timeoutMs
    });
  }

  async refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined> {
    const oauth = this.config.oauth;
    if (
      this.config.authMode !== "oauth-bearer"
      || !oauth?.refreshToken
      || oauth.expiresAt - Date.now() > oauthRefreshWindowMs
    ) return undefined;
    const extensionHandler = this.ai.credentialHandler(oauth.provider);
    if (extensionHandler) return await extensionHandler(this.config, signal);
    if (oauth.provider !== "claude-code" && oauth.provider !== "openai-codex") {
      throw new Error(`No credential refresh handler registered for ${oauth.provider}.`);
    }
    const refreshed = await refreshSubscriptionOAuthTokens(oauth.provider, {
      accessToken: this.config.apiKey ?? "",
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      accountId: oauth.accountId
    }, signal);
    return {
      ...this.config,
      apiKey: refreshed.accessToken,
      oauth: {
        provider: oauth.provider,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId
      }
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    const envName = this.config.apiKeyEnv ?? this.definition.apiKeyEnv;
    return envName ? process.env[envName] : undefined;
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRuntime>();

  constructor(
    private readonly config: AgentConfig,
    catalogs: readonly [string, ModelCatalogEntry[]][] = [],
    private readonly ai: AiRegistry = new AiRegistry(),
    modelsStore?: ModelsStore
  ) {
    for (const [id, provider] of Object.entries(config.providers)) {
      const registration = ai.providers.get(provider.type);
      this.providers.set(id, new ConfiguredProviderRuntime(id, provider, ai, registration?.models, modelsStore));
    }
    for (const [id, models] of catalogs) this.providers.get(id)?.restoreModels(models);
  }

  get(id: string): ProviderRuntime | undefined {
    return this.providers.get(id);
  }

  require(id: string): ProviderRuntime {
    const provider = this.get(id);
    if (!provider) throw new Error(`Unknown provider alias: ${id}`);
    return provider;
  }

  forModel(alias: string): { provider: ProviderRuntime; model: ModelAliasConfig } {
    const model = this.config.models[alias];
    if (!model) throw new Error(`Unknown model alias: ${alias}`);
    return { provider: this.require(model.provider), model };
  }

  createModelSettings(alias = this.config.defaultModel): NativeModelSettings {
    const { provider, model } = this.forModel(alias);
    return provider.createModelSettings(this.config, model);
  }

  validate(alias = this.config.defaultModel): void {
    const { provider, model } = this.forModel(alias);
    provider.validate(model);
  }

  async refreshModels(id: string, signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    return await this.require(id).refreshModels(signal);
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return [...this.providers].flatMap(([id, provider]) => {
      const models = provider.getModels();
      return models.length ? [[id, models] as [string, ModelCatalogEntry[]]] : [];
    });
  }
}

function nativeProtocolForModel(
  model: ModelAliasConfig,
  provider: ProviderConfig,
  definition: ProviderDefinition
): "anthropic" | "openai-compatible" {
  if (model.apiBackend === "anthropic_messages") return "anthropic";
  if (model.apiBackend === "chat_completions") return "openai-compatible";
  return providerProtocol(provider, definition);
}

function missingKeyMessage(providerAlias: string, configuredEnv: string | undefined, defaultEnv: string | undefined): string {
  const envName = configuredEnv ?? defaultEnv;
  const credentialHint = process.platform === "darwin"
    ? `macOS Keychain 中的 provider:${providerAlias}:apiKey 或 ${envName ?? "配置的环境变量"}`
    : (envName ?? `providers.${providerAlias}.apiKeyEnv 环境变量`);
  return `No model available. Set ${credentialHint}.`;
}

function mergeCompatibility(provider: ModelCompatibility | undefined, model: ModelCompatibility | undefined): ModelCompatibility | undefined {
  if (!provider && !model) return undefined;
  return { ...provider, ...model };
}

function createProviderOptions(
  providerType: ProviderConfig["type"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, unknown> | undefined {
  if (mergeCompatibility(provider.compatibility, model.compatibility)?.supportsReasoning === false) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  const api: ModelApiBackend = model.apiBackend
    ?? provider.apiBackend
    ?? (providerType === "openai-codex"
      ? "responses"
      : provider.protocol === "anthropic" || providerType === "anthropic" || providerType === "claude-subscription"
        ? "anthropic_messages"
        : "chat_completions");
  if (api === "anthropic_messages") return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  if (providerType === "deepseek") return { deepseek: { thinking: { type: enabled ? "enabled" : "disabled" }, reasoningEffort: enabled ? nativeEffort : undefined } };
  if (providerType === "openai") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (providerType === "qwen") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (providerType === "kimi") {
    if (isKimiK3Model(model.model)) return { moonshotai: { reasoningEffort: enabled ? nativeEffort ?? "high" : "low" } };
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled" } } };
  }
  return undefined;
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveSimpleThinking(
  config: AgentConfig,
  model: ModelAliasConfig,
  requested: ModelStreamOptions["reasoning"]
): AgentConfig["thinking"] {
  if (requested === undefined) return config.thinking;
  if (requested === "off") return { enabled: false, effort: config.thinking.effort };
  const native = modelThinkingLevelMap(model)[requested];
  if (native === undefined || native === null || !modelReasoningConfig(model)?.efforts.includes(requested)) {
    throw new Error(`Model ${model.model} does not support ${requested} thinking effort.`);
  }
  return { enabled: true, effort: requested };
}
