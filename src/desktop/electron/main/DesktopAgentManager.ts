import type { AgentRunMode } from "../../../agent/AgentSession.js";
import { promises as fs } from "node:fs";
import { generateText } from "ai";
import { configSchema, type AgentConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";
import { createModelSettings } from "../../../llm/factory.js";
import type { ModelRuntimeInfo, ThinkingSelection } from "../../../llm/ModelManager.js";
import { providerProfile } from "../../../llm/profiles.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { createInteractiveAgentRuntime, type InteractiveAgentRuntime } from "../../../runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../../../runtime/agentEvents.js";
import type {
  DesktopAttachment,
  DesktopModelConfigurationInput,
  DesktopModelConnectionTestResult,
  DesktopModelLoginProvider,
  DesktopModelLoginStartResult,
  DesktopRunReceipt,
  DesktopSessionDocument,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopModelLoginService, type AuthenticatedModelLogin } from "./DesktopModelLoginService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";

interface ManagedRuntime {
  runtime: InteractiveAgentRuntime;
  unsubscribe(): void;
}

export class DesktopAgentManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeInitializations = new Map<string, Promise<InteractiveAgentRuntime>>();
  private readonly liveEvents = new Map<string, Map<string, AgentHostEvent[]>>();
  private readonly runtimeErrors = new Map<string, string>();
  private readonly modelLogin: DesktopModelLoginService;
  private closing = false;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly projects: DesktopProjectService,
    private readonly configStore: AgentConfigStore,
    private readonly emit: (projectId: string, event: AgentHostEvent) => void,
    openExternal?: (url: string) => Promise<void>
  ) {
    this.modelLogin = new DesktopModelLoginService(openExternal ?? (async () => {
      throw new Error("当前环境无法打开浏览器。");
    }));
  }

  async workspaceSnapshot(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const storedProject = this.projects.requireProject(projectId);
    const project = await this.projects.inspectProject(storedProject);
    await this.state.upsertProject({ ...project, lastOpenedAt: new Date().toISOString() });
    const runtime = this.runtimes.get(projectId)?.runtime;
    const [models, sessions] = await Promise.all([
      this.projects.listModels(project).catch(() => []),
      this.projects.listSessions(project, runtime?.getSnapshot(), this.projectEvents(projectId))
    ]);
    return {
      project,
      sessions,
      selectedSessionId: this.state.selectedSessionId(projectId),
      runtime: runtime?.getSnapshot(),
      runtimeError: this.runtimeErrors.get(projectId),
      models
    };
  }

  async startDraft(projectId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed?.runtime.getSnapshot().activeRun || managed?.runtime.getSnapshot().queuedRuns.length) {
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
    mode: AgentRunMode,
    attachments: DesktopAttachment[]
  ): Promise<DesktopRunReceipt> {
    await this.refreshOAuthCredentials(projectId);
    const runtime = await this.ensureRuntime(projectId);
    const snapshot = runtime.getSnapshot();
    if (!snapshot.activeRun && !snapshot.queuedRuns.length) await runtime.refreshModelFromDisk();
    if (sessionId && runtime.getInfo().sessionId !== sessionId) {
      const snapshot = runtime.getSnapshot();
      if (snapshot.activeRun || snapshot.queuedRuns.length) {
        throw new Error("The selected session is still running. Return to it or stop the task before resuming another session.");
      }
      await runtime.resumeSession(sessionId);
    }
    const info = runtime.getInfo();
    const prompt = withAttachmentReferences(input, attachments);
    const submitted = runtime.submitPrompt(prompt, mode);
    await this.state.setSelectedSession(projectId, info.sessionId);
    void submitted.completion.catch(() => undefined);
    return {
      sessionId: info.sessionId,
      runId: submitted.runId,
      messageId: submitted.messageId,
      queued: submitted.queued
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
    const runtime = await this.ensureRuntime(projectId);
    await runtime.setPermissionMode(mode);
    return await this.workspaceSnapshot(projectId);
  }

  async switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo> {
    await this.refreshOAuthCredentials(projectId);
    return await (await this.ensureRuntime(projectId)).switchModel(alias, thinking);
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
    if (managed?.runtime.getSnapshot().activeRun || managed?.runtime.getSnapshot().queuedRuns.length) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const authenticated = await this.modelLogin.complete(provider, authRequestId, pastedAuthorization);
    const current = await this.configStore.load();
    const candidate = this.buildConfigWithAuthenticatedLogin(current, authenticated);
    const test = await this.testCandidate(candidate, candidate.defaultModel);
    if (!test.ok) throw new Error(`账号已授权，但模型验证失败：${test.message}`);
    await this.configStore.save(candidate);
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
    if (managed?.runtime.getSnapshot().activeRun || managed?.runtime.getSnapshot().queuedRuns.length) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.configStore.load();
    const next = this.buildConfigWithModel(current, input);
    await this.configStore.save(next);
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
    if (managed?.runtime.getSnapshot().activeRun || managed?.runtime.getSnapshot().queuedRuns.length) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    this.projects.requireProject(projectId);
    const current = await this.configStore.load();
    if (!current.models[alias]) throw new Error(`未知模型：${alias}`);
    const remaining = Object.entries(current.models).filter(([key]) => key !== alias);
    if (!remaining.length) throw new Error("至少需要保留一个可用模型。");
    const nextDefault = current.defaultModel === alias ? remaining[0]![0] : current.defaultModel;
    const next = configSchema.parse({
      ...current,
      defaultModel: nextDefault,
      models: Object.fromEntries(remaining)
    });
    await this.configStore.save(next);
    this.runtimeErrors.delete(projectId);
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.workspaceSnapshot(projectId);
  }

  async testModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> {
    this.projects.requireProject(projectId);
    const current = await this.configStore.load();
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
    if (profile.requiresApiKey && !hasKey) {
      return { ok: false, message: envName ? `缺少 API Key。请填写密钥，或设置环境变量 ${envName}。` : "缺少 API Key。请先填写密钥后再测试。" };
    }
    const started = Date.now();
    try {
      const settings = createModelSettings(candidate, alias);
      await generateText({
        model: settings.model,
        prompt: "ping",
        maxOutputTokens: 16,
        temperature: 0
      });
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
      baseUrl: input.baseUrl ?? existingProvider?.baseUrl ?? profile.baseUrl,
      apiKey: input.apiKey ?? existingProvider?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existingProvider?.apiKeyEnv ?? profile.apiKeyEnv,
      authMode: existingProvider?.authMode,
      oauth: existingProvider?.oauth,
      timeoutMs: existingProvider?.timeoutMs
    };
    const models = Object.fromEntries(Object.entries(current.models).filter(([alias, model]) => (
      alias === input.alias || model.provider !== input.providerAlias || model.model !== input.model
    )));
    return configSchema.parse({
      ...current,
      defaultModel: input.alias,
      providers: { ...current.providers, [input.providerAlias]: provider },
      models: {
        ...models,
        [input.alias]: {
          provider: input.providerAlias,
          model: input.model,
          displayName: input.displayName,
          supportsTools: input.supportsTools,
          thinking: input.supportsThinking ? { efforts: ["high", "max"], defaultEffort: "high" } : undefined
        }
      },
      thinking: { enabled: false, effort: "high" }
    });
  }

  async compact(projectId: string, hint?: string): Promise<string> {
    return await (await this.ensureRuntime(projectId)).compactConversation(hint);
  }

  async duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const project = this.projects.requireProject(projectId);
    const targetSessionId = await this.projects.duplicateSession(project, sessionId);
    await this.state.setSelectedSession(projectId, targetSessionId);
    return await this.workspaceSnapshot(projectId);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed?.runtime.getInfo().sessionId === sessionId) {
      const snapshot = managed.runtime.getSnapshot();
      if (snapshot.activeRun || snapshot.queuedRuns.length) throw new Error("Stop the running task before deleting this session.");
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

  hasRunningTasks(): boolean {
    return [...this.runtimes.values()].some(({ runtime }) => {
      const snapshot = runtime.getSnapshot();
      return Boolean(snapshot.activeRun || snapshot.pendingPermission || snapshot.queuedRuns.length);
    });
  }

  isProjectRunning(projectId: string): boolean {
    const runtime = this.runtimes.get(projectId)?.runtime;
    if (!runtime) return false;
    const snapshot = runtime.getSnapshot();
    return Boolean(snapshot.activeRun || snapshot.pendingPermission || snapshot.queuedRuns.length);
  }

  cancelAll(): void {
    for (const { runtime } of this.runtimes.values()) runtime.cancelCurrentRun();
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.runtimeInitializations.values());
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const managed of managedRuntimes) managed.unsubscribe();
    await Promise.all(managedRuntimes.map(async ({ runtime }) => await runtime.close()));
  }

  private async ensureRuntime(projectId: string): Promise<InteractiveAgentRuntime> {
    if (this.closing) throw new Error("Desktop runtime is shutting down.");
    const current = this.runtimes.get(projectId)?.runtime;
    if (current) return current;
    const pending = this.runtimeInitializations.get(projectId);
    if (pending) return await pending;
    const initialization = this.initializeRuntime(projectId);
    this.runtimeInitializations.set(projectId, initialization);
    try {
      return await initialization;
    } finally {
      if (this.runtimeInitializations.get(projectId) === initialization) this.runtimeInitializations.delete(projectId);
    }
  }

  private async initializeRuntime(projectId: string): Promise<InteractiveAgentRuntime> {
    const project = this.projects.requireProject(projectId);
    if (project.missing) throw new Error(`Project path is unavailable: ${project.path}`);
    await this.refreshOAuthCredentials(projectId);
    const persistenceRoot = await this.projects.dataRoot(project);
    const runtime = await createInteractiveAgentRuntime(project.path, {
      persistenceRoot,
      configStore: this.configStore,
      attachmentRoot: this.projects.attachmentsRoot(project)
    });
    const initialSessionFile = runtime.getInfo().sessionFile;
    const selectedSessionId = this.state.selectedSessionId(projectId);
    if (selectedSessionId) {
      try {
        await runtime.resumeSession(selectedSessionId);
      } catch (error) {
        if (isMissingSession(error)) {
          await this.state.setSelectedSession(projectId, undefined);
        } else {
          await runtime.close();
          await fs.rm(initialSessionFile, { force: true });
          throw error;
        }
      }
    }
    const unsubscribe = runtime.subscribe((event) => {
      const projectEvents = this.projectEvents(projectId);
      const sessionEvents = projectEvents.get(event.sessionId) ?? [];
      sessionEvents.push(event);
      if (sessionEvents.length > 4_000) sessionEvents.splice(0, sessionEvents.length - 4_000);
      projectEvents.set(event.sessionId, sessionEvents);
      this.emit(projectId, event);
    });
    this.runtimes.set(projectId, { runtime, unsubscribe });
    return runtime;
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
        thinking: model.supportsThinking ? { efforts: ["high", "max"], defaultEffort: "high" } : undefined
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

  private async refreshOAuthCredentials(projectId: string): Promise<void> {
    this.projects.requireProject(projectId);
    const current = await this.configStore.load();
    let refreshedConfig: AgentConfig | undefined;
    for (const [alias, provider] of Object.entries(current.providers)) {
      const oauth = provider.oauth;
      if (provider.authMode !== "oauth-bearer" || !oauth || !oauth.refreshToken || oauth.expiresAt - Date.now() > 5 * 60 * 1_000) continue;
      const refreshed = await this.modelLogin.refresh(oauth.provider, {
        accessToken: provider.apiKey ?? "",
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        accountId: oauth.accountId
      });
      refreshedConfig ??= structuredClone(current);
      refreshedConfig.providers[alias] = {
        ...provider,
        apiKey: refreshed.accessToken,
        oauth: {
          provider: oauth.provider,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          accountId: refreshed.accountId
        }
      };
    }
    if (refreshedConfig) await this.configStore.save(refreshedConfig);
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

function isMissingSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session not found:") || message.startsWith("Session file not found:");
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

function withAttachmentReferences(input: string, attachments: DesktopAttachment[]): string {
  if (!attachments.length) return input;
  return [
    input,
    "",
    "Attached files (read them with read_file using these @attachments/ paths):",
    ...attachments.map((attachment) => `- ${attachment.path} (${attachment.mimeType || "unknown type"}, ${String(attachment.size)} bytes)`)
  ].join("\n");
}
