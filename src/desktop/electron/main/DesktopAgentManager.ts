/**
 * 桌面端 agent 运行时管理。
 *
 * 每个项目一个 `InteractiveAgentRuntime`，按需懒创建并缓存在 `runtimes` 里；
 * 一个项目同一时刻只能有一个活动会话在跑，切换会话前必须先停掉当前运行。
 *
 * 几处需要注意的状态：
 * - `runtimeInitializations` 缓存正在创建中的 promise，避免并发请求把同一个项目初始化两次；
 * - `liveEvents` 暂存本轮的实时事件，界面重新打开会话时要把它们接在历史事件后面；
 * - `runtimeErrors` 记住初始化失败原因，让界面能显示「为什么这个项目起不来」而不是一直转圈。
 *
 * 模型配置的保存与连通性测试也在这里：写入前先用候选配置实际发一次请求，避免存下一份用不了的配置。
 */
import type { AgentAttachment, InteractiveAgentRunMode } from "../../../agent/AgentSession.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchModelCatalog } from "../../../ai/modelCatalog.js";
import { thinkingLevelMapForModel } from "../../../ai/capabilities.js";
import { providerDefinition } from "../../../ai/provider.js";
import { loadProjectSettings } from "../../../config/projectSettings.js";
import { configSchema, type AgentConfig, type ProviderConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import { createNativeModelSettings, validateModelConfiguration } from "../../../llm/nativeFactory.js";
import { hasUsableModelConfiguration, listConfiguredModelChoices, type ModelRuntimeInfo, type ThinkingSelection } from "../../../llm/ModelManager.js";
import { providerProfile } from "../../../llm/profiles.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { webSearchKeyEnvNames } from "../../../tools/web/search.js";
import { executeRuntimeCommand } from "../../../runtime/commands.js";
import {
  createInteractiveAgentHost,
  type AgentRunOutcome,
  type InteractiveAgentRuntime
} from "../../../runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../../../runtime/CommandRuntime.js";
import { SessionLeaseError } from "../../../runtime/SessionLease.js";
import { runtimeIsBusy, type AgentHostEvent, type AgentRuntimeUpdate } from "../../../runtime/agentEvents.js";
import { withAttachmentReferences } from "../../attachmentReferences.js";
import type {
  DesktopAttachment,
  DesktopMemoryCompactionResult,
  DesktopMemoryOverview,
  DesktopMemorySearchMatch,
  DesktopMemorySettings,
  DesktopModelCatalogResult,
  DesktopModelConfigurationInput,
  DesktopModelConnection,
  DesktopModelConnectionTestResult,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopRunReceipt,
  DesktopSessionDocument,
  DesktopSlashResult,
  DesktopWebSearchSettings,
  DesktopWebSearchSettingsInput,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopModelLoginService, type AuthenticatedModelLogin } from "./DesktopModelLoginService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

interface ManagedRuntime {
  runtime: InteractiveAgentRuntime;
  commands: CommandRuntime;
  unsubscribe(): void;
}

export class DesktopAgentManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>();
  private readonly liveEvents = new Map<string, Map<string, AgentHostEvent[]>>();
  private readonly runtimeErrors = new Map<string, string>();
  private readonly modelLogin: DesktopModelLoginService;
  private closing = false;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly projects: DesktopProjectService,
    private readonly configStore: AgentConfigStore,
    private readonly emit: (projectId: string, update: AgentRuntimeUpdate) => void,
    openExternal?: (url: string) => Promise<void>
  ) {
    this.modelLogin = new DesktopModelLoginService(openExternal ?? (async () => {
      throw new Error("当前环境无法打开浏览器。");
    }));
  }

  async workspaceSnapshot(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const storedProject = this.projects.requireProject(projectId);
    const project = await this.projects.inspectProject(storedProject);
    // Keep lastOpenedAt stable on select/refresh so the sidebar order does not jump.
    await this.state.upsertProject(project);
    const runtime = this.runtimes.get(projectId)?.runtime;
    const [config, sessions] = await Promise.all([
      this.configStore.load(project.path).catch(() => undefined),
      this.projects.listSessions(project, runtime?.getSnapshot(), this.projectEvents(projectId))
    ]);
    const models = config ? listConfiguredModelChoices(config) : [];
    return {
      project,
      sessions,
      selectedSessionId: this.state.selectedSessionId(projectId),
      runtime: runtime?.getSnapshot(),
      runtimeError: this.runtimeErrors.get(projectId),
      requiresModelConfiguration: !config || !hasUsableModelConfiguration(config),
      models,
      connections: config ? describeModelConnections(config) : []
    };
  }

  async startDraft(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("当前项目仍有任务运行。请先停止它，或稍后再开始新任务。");
    }
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    await this.state.setSelectedSession(projectId, undefined);
    this.runtimeErrors.delete(projectId);
    return await this.workspaceSnapshot(projectId);
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectPinned(projectId, pinned);
    return await this.workspaceSnapshot(projectId);
  }

  async renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot> {
    await this.state.setProjectName(projectId, name);
    return await this.workspaceSnapshot(projectId);
  }

  async openSession(projectId: string, sessionId: string): Promise<DesktopSessionDocument> {
    await this.state.setSelectedSession(projectId, sessionId);
    const project = this.projects.requireProject(projectId);
    const runtime = this.runtimes.get(projectId)?.runtime;
    return await this.projects.openSession(project, sessionId, runtime?.getSnapshot(), this.projectEvents(projectId));
  }

  async sendPrompt(
    projectId: string,
    sessionId: string | undefined,
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[]
  ): Promise<DesktopRunReceipt> {
    const { runtime } = await this.ensureRuntime(projectId);
    const snapshot = runtime.getSnapshot();
    if (runtimeIsBusy(snapshot)) {
      throw new Error("当前任务仍在运行。请先停止它，再发送下一条消息。");
    }
    // 目标会话不是运行时当前会话时需要切过去，但只能在完全空闲时切。
    if (sessionId && runtime.getSnapshot().info.sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) {
        throw new Error("The selected session is still running. Return to it or stop the task before resuming another session.");
      }
      await runtime.resumeSession(sessionId);
    }
    const info = runtime.getSnapshot().info;
    const prompt = withAttachmentReferences(input, attachments);
    const project = this.projects.requireProject(projectId);
    const nativeAttachments = await loadNativeAttachments(this.projects.attachmentsRoot(project), attachments);
    const submitted = runtime.submitPrompt(prompt, mode, nativeAttachments);
    await this.state.setSelectedSession(projectId, info.sessionId);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId: info.sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  /**
   * 编辑并重发某条用户消息。
   *
   * 做法是分叉出一个只保留该消息之前内容的新会话，再在新会话里发送新消息，原会话保持不变。
   * 因此必须先取消当前运行、等它真正结束、销毁旧运行时，否则旧运行时还会往老会话里写事件。
   */
  async editPrompt(
    projectId: string,
    sessionId: string,
    userMessageIndex: number,
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[]
  ): Promise<DesktopRunReceipt> {
    const { runtime } = await this.ensureRuntime(projectId);
    if (runtime.getSnapshot().info.sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) {
        throw new Error("当前项目仍有其他会话正在运行，请先停止后再编辑消息。");
      }
      await runtime.resumeSession(sessionId);
    }
    const snapshot = runtime.getSnapshot();
    if (runtimeIsBusy(snapshot)) {
      runtime.cancelCurrentRun();
      await runtime.waitForIdle();
    }
    await this.disposeRuntime(projectId);
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.forkSessionAtUserMessage(project, sessionId, userMessageIndex);
    await this.state.setSelectedSession(projectId, targetSessionId);
    this.runtimeErrors.delete(projectId);

    const { runtime: nextRuntime } = await this.ensureRuntime(projectId);
    const info = nextRuntime.getSnapshot().info;
    const prompt = withAttachmentReferences(input, attachments);
    const nativeAttachments = await loadNativeAttachments(this.projects.attachmentsRoot(project), attachments);
    const submitted = nextRuntime.submitPrompt(prompt, mode, nativeAttachments);
    this.observeRunCompletion(projectId, submitted.completion);
    return {
      sessionId: info.sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId
    };
  }

  async cancelRun(projectId: string): Promise<void> {
    this.runtimes.get(projectId)?.runtime.cancelCurrentRun();
  }

  async resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void> {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) throw new Error("Project runtime is not active.");
    runtime.answerPermission(requestId, result);
  }

  async setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    await runtime.runExclusiveOperation(
      "permission",
      async () => await commands.agent.setPermissionMode(mode)
    );
    return await this.workspaceSnapshot(projectId);
  }

  async switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const { runtime, commands } = await this.ensureRuntime(projectId);
    return await runtime.runExclusiveOperation(
      "switch_model",
      async () => await commands.agent.switchModel(alias, thinking)
    );
  }

  async startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult> {
    this.projects.requireProject(projectId);
    return await this.modelLogin.start(provider);
  }

  async completeModelLogin(
    projectId: string,
    provider: DesktopModelLoginProvider,
    authRequestId: string,
    pastedAuthorization?: string
  ): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const authenticated = await this.modelLogin.complete(provider, authRequestId, pastedAuthorization);
    const current = await this.loadProjectConfig(projectId);
    const candidate = this.buildConfigWithAuthenticatedLogin(current, authenticated);
    const test = await this.testCandidate(candidate, candidate.defaultModel);
    if (!test.ok) throw new Error(`账号已授权，但模型验证失败：${test.message}`);
    await this.saveProjectConfig(projectId, candidate);
    this.runtimeErrors.delete(projectId);
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void> {
    this.projects.requireProject(projectId);
    this.modelLogin.cancel(provider, authRequestId);
  }

  async saveModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const next = this.buildConfigWithModel(current, input);
    // 写入全局配置前先验证候选模型的 endpoint、协议和凭据；运行时切换还会再次经过
    // ModelManager 的同一校验，避免设置页和 TUI/CLI 产生两套可用性规则。
    if (input.makeDefault || next.defaultModel === input.alias) validateModelConfiguration(next, input.alias);
    await this.saveProjectConfig(projectId, next);
    this.runtimeErrors.delete(projectId);
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async removeModelConfiguration(projectId: string, alias: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    if (!current.models[alias]) throw new Error(`未知模型：${alias}`);
    const projectSettings = await loadProjectSettings(this.projects.requireProject(projectId).path);
    if (projectSettings.defaultModel === alias) {
      throw new Error(`不能删除项目 .biny/settings.json 当前引用的模型：${alias}`);
    }
    const remaining = Object.entries(current.models).filter(([key]) => key !== alias);
    if (!remaining.length) throw new Error("至少需要保留一个可用模型。");
    const nextDefault = current.defaultModel === alias ? remaining[0]![0] : current.defaultModel;
    const next = configSchema.parse({
      ...current,
      defaultModel: nextDefault,
      models: Object.fromEntries(remaining)
    });
    await this.saveProjectConfig(projectId, next);
    this.runtimeErrors.delete(projectId);
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async webSearchSettings(projectId: string): Promise<DesktopWebSearchSettings> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    return describeWebSearchSettings(config.web.search);
  }

  async saveWebSearchSettings(projectId: string, input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改联网搜索配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    // 密钥槽位是各 provider 共用的：换 provider 时必须丢弃旧密钥和自定义 env 名，
    // 否则上一家的密钥会被原样发给新服务商，并遮蔽环境变量里的正确密钥。
    const sameProvider = input.provider === current.web.search.provider;
    const next = configSchema.parse({
      ...current,
      web: {
        ...current.web,
        search: {
          enabled: input.enabled,
          provider: input.provider,
          // undefined 保留同 provider 的已存密钥，空字符串表示清除。
          apiKey: input.apiKey === undefined ? (sameProvider ? current.web.search.apiKey : undefined) : input.apiKey || undefined,
          apiKeyEnv: sameProvider ? input.apiKeyEnv : undefined,
          timeoutMs: input.timeoutMs,
          maxResults: input.maxResults
        }
      }
    });
    await this.saveProjectConfig(projectId, next);
    // 工具注册表在 runtime 装配时读取搜索配置，关闭后下次使用即按新配置重建。
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return describeWebSearchSettings(next.web.search);
  }

  /** 记忆面板总览：设置来自配置文件；条目列表需要活的 runtime（记忆禁用时不创建）。 */
  async memoryOverview(projectId: string): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    const settings = describeMemorySettings(config);
    if (!settings.enabled) return { settings, totalEntries: 0, topics: [], entries: [] };
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const entries = await runtime.runExclusiveOperation(
      "memory",
      async () => await requireLocalMemory(commands).listEntries()
    );
    const topicCounts = new Map<string, number>();
    for (const entry of entries) topicCounts.set(entry.topic, (topicCounts.get(entry.topic) ?? 0) + 1);
    return {
      settings,
      totalEntries: entries.length,
      topics: [...topicCounts.entries()].map(([topic, count]) => ({ topic, entries: count })),
      entries
    };
  }

  async saveMemorySettings(projectId: string, input: DesktopMemorySettings): Promise<DesktopMemoryOverview> {
    const managed = this.runtimes.get(projectId);
    if (managed && runtimeIsBusy(managed.runtime.getSnapshot())) {
      throw new Error("任务运行期间不能修改记忆设置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const next = configSchema.parse({
      ...current,
      context: {
        ...current.context,
        memory: {
          enabled: input.enabled,
          autoRemember: input.autoRemember,
          maxRecalled: input.maxRecalled,
          model: input.model
        }
      }
    });
    await this.saveProjectConfig(projectId, next);
    // 记忆配置在 runtime 装配时读取；关闭后下次使用即按新配置重建。
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.memoryOverview(projectId);
  }

  async searchMemory(projectId: string, query: string): Promise<DesktopMemorySearchMatch[]> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    return await runtime.runExclusiveOperation(
      "memory",
      async () => await requireLocalMemory(commands).findRelevant(query, [], 8)
    );
  }

  async addMemoryEntry(projectId: string, topic: string, note: string): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const result = await runtime.runExclusiveOperation(
      "memory",
      async () => await requireLocalMemory(commands).write({
        topic,
        title: note.split("\n", 1)[0]?.slice(0, 120) ?? "Project note",
        summary: note,
        decisions: [],
        paths: [],
        keywords: []
      })
    );
    if (!result.written) {
      throw new Error(result.path ? "已存在等价的记忆条目，未重复保存。" : "内容太短，至少需要 20 个字符才能作为持久记忆。");
    }
    return await this.memoryOverview(projectId);
  }

  async deleteMemoryEntry(projectId: string, topic: string, index: number): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    const removed = await runtime.runExclusiveOperation(
      "memory",
      async () => await requireLocalMemory(commands).deleteEntry(topic, index)
    );
    if (!removed) throw new Error("未找到该记忆条目，可能已被删除。");
    return await this.memoryOverview(projectId);
  }

  async clearMemory(projectId: string): Promise<DesktopMemoryOverview> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    await runtime.runExclusiveOperation("memory", async () => {
      const memory = requireLocalMemory(commands);
      for (const topic of await memory.listTopics()) await memory.forgetTopic(topic);
    });
    return await this.memoryOverview(projectId);
  }

  async compactMemory(projectId: string): Promise<DesktopMemoryCompactionResult[]> {
    this.projects.requireProject(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    return await runtime.runExclusiveOperation(
      "memory",
      async () => await requireLocalMemory(commands).compactTopics()
    );
  }

  /**
   * Asks the provider for its live model list. Never throws for an offline or
   * unauthenticated provider — the caller renders `source: "fallback"` and keeps
   * showing whatever static catalog it already had.
   */
  async fetchModelCatalog(projectId: string, providerAlias: string): Promise<DesktopModelCatalogResult> {
    this.projects.requireProject(projectId);
    const config = await this.loadProjectConfig(projectId);
    const provider = config.providers[providerAlias];
    if (!provider) throw new Error(`未找到服务商配置：${providerAlias}`);
    const fetchedAt = new Date().toISOString();
    try {
      const models = await fetchModelCatalog({
        alias: providerAlias,
        config: provider,
        definition: providerDefinition(provider.type)
      });
      return { providerAlias, source: "fetched", fetchedAt, models };
    } catch {
      return { providerAlias, source: "fallback", fetchedAt, models: [] };
    }
  }

  async testModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> {
    this.projects.requireProject(projectId);
    const current = await this.loadProjectConfig(projectId);
    const candidate = this.buildConfigWithModel(current, input);
    return await this.testCandidate(candidate, input.alias);
  }

  private async testCandidate(candidate: AgentConfig, alias: string): Promise<DesktopModelConnectionTestResult> {
    const model = candidate.models[alias];
    if (!model) return { ok: false, message: `未知模型：${alias}` };
    const provider = candidate.providers[model.provider];
    if (!provider) {
      return { ok: false, message: `未找到服务商配置：${model.provider}` };
    }
    const profile = providerProfile(provider.type);
    const envName = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const hasKey = Boolean(provider.apiKey || (envName && process.env[envName]));
    if ((provider.requiresApiKey ?? profile.requiresApiKey) && !hasKey) {
      return { ok: false, message: envName ? `缺少 API Key。请填写密钥，或设置环境变量 ${envName}。` : "缺少 API Key。请先填写密钥后再测试。" };
    }
    const started = Date.now();
    try {
      const settings = createNativeModelSettings(candidate, alias);
      let providerError: string | undefined;
      for await (const event of await settings.model.stream({
        messages: [{ role: "user", content: "ping" }],
        tools: []
      }, {
        maxOutputTokens: 16,
        reasoning: settings.reasoning,
        providerOptions: settings.providerOptions,
        timeoutMs: settings.timeoutMs
      })) {
        if (event.type === "error") providerError = event.error instanceof Error ? event.error.message : String(event.error);
      }
      if (providerError) throw new Error(providerError);
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        message: `连接成功 · ${String(latencyMs)}ms`,
        latencyMs
      };
    } catch (error) {
      return {
        ok: false,
        message: formatModelConnectionError(error),
        latencyMs: Date.now() - started
      };
    }
  }

  private buildConfigWithModel(current: AgentConfig, input: DesktopModelConfigurationInput): AgentConfig {
    const existingProvider = current.providers[input.providerAlias];
    const profile = providerProfile(input.providerType);
    const provider = {
      type: input.providerType,
      protocol: input.protocol,
      baseUrl: input.baseUrl ?? existingProvider?.baseUrl ?? profile.baseUrl,
      apiKey: input.apiKey ?? existingProvider?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existingProvider?.apiKeyEnv ?? profile.apiKeyEnv,
      requiresApiKey: input.requiresApiKey,
      authMode: existingProvider?.authMode,
      oauth: existingProvider?.oauth,
      timeoutMs: existingProvider?.timeoutMs
    };
    const models = Object.fromEntries(Object.entries(current.models).filter(([alias, model]) => (
      alias === input.alias || model.provider !== input.providerAlias || model.model !== input.model
    )));
    // Enabling an extra model, rotating a key or editing a base URL must not
    // silently hijack the active default — only an explicit connect does, and
    // the de-dup above can still strip the previous default out from under us.
    const keepsCurrentDefault = input.alias === current.defaultModel || Boolean(models[current.defaultModel]);
    const defaultModel = input.makeDefault || !keepsCurrentDefault ? input.alias : current.defaultModel;
    return configSchema.parse({
      ...current,
      defaultModel,
      providers: { ...current.providers, [input.providerAlias]: provider },
      models: {
        ...models,
        [input.alias]: {
          provider: input.providerAlias,
          model: input.model,
          displayName: input.displayName,
          supportsTools: input.supportsTools,
          capabilities: {
            tools: input.supportsTools,
            reasoning: input.supportsThinking,
            vision: input.supportsVision,
            audio: input.supportsAudio
          },
          contextWindow: input.contextWindow,
          maxOutputTokens: input.maxOutputTokens,
          apiBackend: input.apiBackend,
          thinkingLevelMap: input.thinkingLevelMap ?? thinkingLevelMapForModel(input.model, input.supportsThinking),
          compatibility: input.compatibility
        }
      },
      // Thinking is validated against the *default* model, so it only has to be
      // reset when the default actually moves to a freshly configured model.
      thinking: defaultModel === current.defaultModel ? current.thinking : { enabled: false, effort: current.thinking.effort }
    });
  }

  async compact(projectId: string, hint?: string): Promise<string> {
    return await (await this.ensureRuntime(projectId)).runtime.compactConversation(hint);
  }

  /**
   * 桌面端斜杠命令。报告类命令直接读 runtime 状态，不产生会话消息；
   * `/subagent <task>` 与 `/review` 会实际派发一个子代理任务（权限档位随会话权限推导，
   * 与 TUI 相同），结果同样只进弹层、不写入会话。
   */
  async runSlashCommand(projectId: string, sessionId: string | undefined, input: string): Promise<DesktopSlashResult> {
    await this.requireConfiguredModel(projectId);
    const { runtime, commands } = await this.ensureRuntime(projectId);
    // /context、/usage 依赖当前会话：用户查看的会话与 runtime 不一致且空闲时先切换。
    if (sessionId && runtime.getSnapshot().info.sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (!runtimeIsBusy(snapshot)) await runtime.resumeSession(sessionId);
    }
    const result = await executeRuntimeCommand(runtime, commands, input, "desktop");
    if (!result) throw new Error(`未知命令：${input.trim().split(/\s+/, 1)[0] ?? input}`);
    return result;
  }

  async duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.duplicateSession(project, sessionId);
    await this.state.setSelectedSession(projectId, targetSessionId);
    return await this.workspaceSnapshot(projectId);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed?.runtime.getSnapshot().info.sessionId === sessionId) {
      const snapshot = managed.runtime.getSnapshot();
      if (runtimeIsBusy(snapshot)) throw new Error("Stop the running task before deleting this session.");
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    await this.projects.deleteSession(this.projects.requireProject(projectId), sessionId);
    await this.state.setSelectedSession(projectId, undefined);
    return await this.workspaceSnapshot(projectId);
  }

  async disposeProject(projectId: string): Promise<void> {
    const managed = this.runtimes.get(projectId);
    if (!managed) return;
    managed.unsubscribe();
    await managed.runtime.close();
    this.runtimes.delete(projectId);
  }

  /** 关窗前用它决定要不要提示用户：等待权限也算「在跑」，直接关掉会丢掉这次询问。 */
  hasRunningTasks(): boolean {
    return [...this.runtimes.values()].some(({ runtime }) => {
      return runtimeIsBusy(runtime.getSnapshot());
    });
  }

  isProjectRunning(projectId: string): boolean {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) return false;
    return runtimeIsBusy(runtime.getSnapshot());
  }

  cancelAll(): void {
    for (const { runtime } of this.runtimes.values()) runtime.cancelCurrentRun();
  }

  /**
   * 退出前收尾。先置 `closing` 挡住新的创建请求，再等正在初始化的运行时结束（否则它们会
   * 在关闭之后才注册进来，成为泄漏的运行时），最后统一取消订阅并关闭。
   */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.runtimeInitializations.values());
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const managed of managedRuntimes) managed.unsubscribe();
    await Promise.all(managedRuntimes.map(async ({ runtime }) => await runtime.close()));
  }

  private async disposeRuntime(projectId: string): Promise<void> {
    const managed = this.runtimes.get(projectId);
    if (!managed) return;
    managed.unsubscribe();
    await managed.runtime.close();
    this.runtimes.delete(projectId);
  }

  /**
   * 取得项目运行时，没有就创建。并发调用会复用同一个初始化 promise，避免同一项目被初始化两次
   * （两个运行时抢同一份 session 和运行锁）。
   */
  private async ensureRuntime(projectId: string): Promise<ManagedRuntime> {
    if (this.closing) throw new Error("Desktop runtime is shutting down.");
    const current = this.runtimes.get(projectId);
    if (current) return current;
    const pending = this.runtimeInitializations.get(projectId);
    if (pending) return await pending;
    const initialization = this.initializeRuntime(projectId);
    this.runtimeInitializations.set(projectId, initialization);
    try {
      return await initialization;
    } catch (error) {
      const message = formatRuntimeInitializationError(error);
      this.runtimeErrors.set(projectId, message);
      if (error instanceof SessionLeaseError) throw new Error(message);
      throw error;
    } finally {
      if (this.runtimeInitializations.get(projectId) === initialization) this.runtimeInitializations.delete(projectId);
    }
  }

  private observeRunCompletion(projectId: string, completion: Promise<AgentRunOutcome>): void {
    void completion.then(
      (outcome) => {
        // 正常的终态结果通过 AgentHostEvent 呈现，这里不重复上报；
        // 只有真正跑成功了才清掉之前记下的初始化错误。
        if (outcome.status === "completed") this.runtimeErrors.delete(projectId);
      },
      (error: unknown) => {
        this.runtimeErrors.set(projectId, error instanceof Error ? error.message : String(error));
      }
    );
  }

  private async initializeRuntime(projectId: string): Promise<ManagedRuntime> {
    const project = this.projects.requireProject(projectId);
    if (project.missing) throw new Error(`Project path is unavailable: ${project.path}`);
    // session 走全局项目目录，附件仍在项目 `.biny`；三端通过同一个 workspace 定位同一份历史。
    const persistenceRoot = await this.projects.dataRoot(project);
    const { runtime, commands } = await createInteractiveAgentHost(project.path, {
      persistenceRoot,
      configStore: this.configStore,
      attachmentRoot: this.projects.attachmentsRoot(project)
    });
    const initialSessionFile = runtime.getSnapshot().info.sessionFile;
    const selectedSessionId = this.state.selectedSessionId(projectId);
    if (selectedSessionId) {
      try {
        await runtime.resumeSession(selectedSessionId);
      } catch (error) {
        // 会话文件已被删除：清掉选中项，让运行时留在刚创建的新会话上。
        if (isMissingSession(error)) {
          await this.state.setSelectedSession(projectId, undefined);
        } else {
          // 其他错误则整体回滚，包括删掉刚创建但没用上的空 session 文件，避免留下垃圾会话。
          await runtime.close();
          await fs.rm(initialSessionFile, { force: true });
          throw error;
        }
      }
    }
    const unsubscribe = runtime.subscribe((update) => {
      const event = update.event;
      if (event) {
        const projectEvents = this.projectEvents(projectId);
        const sessionEvents = projectEvents.get(event.sessionId) ?? [];
        sessionEvents.push(event);
        // 实时事件只为「重新打开会话时补上本轮内容」，按会话保留最近 4000 条，防止长跑占满内存。
        if (sessionEvents.length > 4_000) sessionEvents.splice(0, sessionEvents.length - 4_000);
        projectEvents.set(event.sessionId, sessionEvents);
      }
      this.emit(projectId, update);
    });
    const managed = { runtime, commands, unsubscribe };
    this.runtimes.set(projectId, managed);
    this.runtimeErrors.delete(projectId);
    return managed;
  }

  private async requireConfiguredModel(projectId: string): Promise<void> {
    const config = await this.loadProjectConfig(projectId);
    if (!hasUsableModelConfiguration(config)) {
      throw new Error("请先在设置的“模型”中配置一个可用模型，再开始任务。");
    }
  }

  private buildConfigWithAuthenticatedLogin(current: AgentConfig, authenticated: AuthenticatedModelLogin): AgentConfig {
    const providerAlias = authenticated.provider;
    const providerType = authenticated.provider === "claude-code" ? "claude-subscription" : "openai-codex";
    const profile = providerProfile(providerType);
    const models = Object.fromEntries(Object.entries(current.models).filter(([, model]) => model.provider !== providerAlias));
    const configuredModels = authenticated.models.map((model) => {
      const alias = modelAliasForAuthenticatedModel(providerAlias, model.id);
      return [alias, {
        provider: providerAlias,
        model: model.id,
        displayName: model.displayName,
        supportsTools: true,
        thinkingLevelMap: thinkingLevelMapForModel(model.id, model.supportsThinking)
      }] as const;
    });
    const defaultModel = configuredModels[0]?.[0];
    if (!defaultModel) throw new Error("账号没有返回可用模型。");
    const existingProvider = current.providers[providerAlias];
    return configSchema.parse({
      ...current,
      defaultModel,
      providers: {
        ...current.providers,
        [providerAlias]: {
          type: providerType,
          baseUrl: profile.baseUrl,
          apiKey: authenticated.accessToken,
          apiKeyEnv: undefined,
          authMode: "oauth-bearer",
          oauth: {
            provider: authenticated.provider,
            refreshToken: authenticated.refreshToken,
            expiresAt: authenticated.expiresAt,
            accountId: authenticated.accountId
          },
          timeoutMs: existingProvider?.timeoutMs
        }
      },
      models: { ...models, ...Object.fromEntries(configuredModels) },
      thinking: { enabled: false, effort: "high" }
    });
  }

  private async loadProjectConfig(projectId: string): Promise<AgentConfig> {
    return await this.configStore.load(this.projects.requireProject(projectId).path);
  }

  private async saveProjectConfig(projectId: string, config: AgentConfig): Promise<void> {
    await this.configStore.save(config, this.projects.requireProject(projectId).path);
  }

  private projectEvents(projectId: string): Map<string, AgentHostEvent[]> {
    const current = this.liveEvents.get(projectId);
    if (current) return current;
    const events = new Map<string, AgentHostEvent[]>();
    this.liveEvents.set(projectId, events);
    return events;
  }
}

function modelAliasForAuthenticatedModel(providerAlias: string, modelId: string): string {
  return `${providerAlias}-${modelId}`.replace(/[^a-z0-9.-]+/gi, "-");
}

/**
 * Projects the saved provider configs into the credential/endpoint facts the
 * settings UI needs. Only presence is reported — an API key or refresh token
 * never crosses the IPC bridge.
 */
function describeWebSearchSettings(search: AgentConfig["web"]["search"]): DesktopWebSearchSettings {
  const envKeyName = search.provider === "duckduckgo" || search.provider === "google"
    ? undefined
    : search.apiKeyEnv ?? webSearchKeyEnvNames[search.provider];
  return {
    enabled: search.enabled,
    provider: search.provider,
    apiKeyEnv: search.apiKeyEnv,
    timeoutMs: search.timeoutMs,
    maxResults: search.maxResults,
    hasApiKey: Boolean(search.apiKey),
    envKeyName,
    envKeyDetected: Boolean(envKeyName && process.env[envKeyName])
  };
}

function describeMemorySettings(config: AgentConfig): DesktopMemorySettings {
  const memory = config.context.memory;
  return { enabled: memory.enabled, autoRemember: memory.autoRemember, maxRecalled: memory.maxRecalled, model: memory.model };
}

function describeModelConnections(config: AgentConfig): DesktopModelConnection[] {
  return Object.entries(config.providers).map(([providerAlias, provider]) => {
    const profile = providerProfile(provider.type);
    const apiKeyEnv = provider.apiKeyEnv ?? profile.apiKeyEnv;
    const credentialSource = describeCredentialSource(provider, apiKeyEnv);
    return {
      providerAlias,
      providerType: provider.type,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl ?? profile.baseUrl,
      requiresApiKey: provider.requiresApiKey ?? profile.requiresApiKey,
      hasCredential: credentialSource !== undefined,
      credentialSource,
      apiKeyEnv,
      authMode: provider.authMode,
      oauthProvider: provider.oauth?.provider,
      oauthExpiresAt: provider.oauth?.expiresAt
    };
  });
}

function describeCredentialSource(provider: ProviderConfig, apiKeyEnv: string | undefined): "keychain" | "config" | "env" | undefined {
  if (provider.apiKey) return process.platform === "darwin" ? "keychain" : "config";
  if (apiKeyEnv && process.env[apiKeyEnv]) return "env";
  return undefined;
}

function isMissingSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session not found:") || message.startsWith("Session file not found:");
}

function requireLocalMemory(services: CommandRuntime) {
  const memory = services.agent.getLocalMemory();
  if (!memory) throw new Error("Local memory is disabled (context.memory.enabled = false).");
  return memory;
}

function formatModelConnectionError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "未知错误");
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) parts.push(`鉴权失败（HTTP ${String(statusCode)}）`);
    else if (statusCode === 404) parts.push(`接口不存在（HTTP 404）`);
    else if (statusCode === 429) parts.push(`请求过于频繁（HTTP 429）`);
    else parts.push(`HTTP ${String(statusCode)}`);
  }
  const message = typeof record.message === "string" ? record.message.trim() : error instanceof Error ? error.message : String(error);
  if (message) parts.push(message);
  const responseBody = typeof record.responseBody === "string" ? record.responseBody.trim() : undefined;
  if (responseBody) {
    const compact = compactJsonError(responseBody);
    if (compact && !parts.some((part) => part.includes(compact))) parts.push(compact);
  }
  const url = typeof record.url === "string" ? record.url : undefined;
  if (url) parts.push(`请求：${url}`);
  const cause = record.cause;
  if (cause instanceof Error && cause.message && !parts.some((part) => part.includes(cause.message))) {
    parts.push(cause.message);
  }
  return parts.filter(Boolean).join(" · ") || "连接失败";
}

function formatRuntimeInitializationError(error: unknown): string {
  if (error instanceof SessionLeaseError) {
    return `当前项目正在被另一个 Biny/CLI 会话占用（进程 ${String(error.pid)}）。请先退出该会话，或切换到其他项目后重试。`;
  }
  return error instanceof Error ? error.message : String(error);
}

function compactJsonError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const detail = error as Record<string, unknown>;
      if (typeof detail.message === "string") return detail.message;
      if (typeof detail.msg === "string") return detail.msg;
    }
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.msg === "string") return parsed.msg;
  } catch {
    // fall through
  }
  const trimmed = body.replace(/\s+/g, " ").trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed || undefined;
}

async function loadNativeAttachments(root: string, attachments: DesktopAttachment[]): Promise<AgentAttachment[]> {
  const normalizedRoot = path.resolve(root);
  const native: AgentAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("audio/")) continue;
    const relative = attachment.path.replace(/^@attachments\//u, "");
    if (!relative || relative.includes("/") || relative.includes("\\")) continue;
    const filePath = path.resolve(normalizedRoot, relative);
    if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${path.sep}`)) continue;
    try {
      const bytes = await fs.readFile(filePath);
      native.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: attachment.path,
        size: attachment.size,
        data: bytes.toString("base64")
      });
    } catch {
      throw new Error(`附件文件不可读取：${attachment.name}`);
    }
  }
  return native;
}
