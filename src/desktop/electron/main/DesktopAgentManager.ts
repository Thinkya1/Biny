import type { AgentRunMode } from "../../../agent/AgentSession.js";
import { promises as fs } from "node:fs";
import { loadConfig, saveConfig } from "../../../config/loader.js";
import { configSchema } from "../../../config/schema.js";
import type { ModelRuntimeInfo, ThinkingSelection } from "../../../llm/ModelManager.js";
import { providerProfile } from "../../../llm/profiles.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { createInteractiveAgentRuntime, type InteractiveAgentRuntime } from "../../../runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../../../runtime/agentEvents.js";
import type {
  DesktopAttachment,
  DesktopModelConfigurationInput,
  DesktopRunReceipt,
  DesktopSessionDocument,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
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
  private closing = false;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly projects: DesktopProjectService,
    private readonly emit: (projectId: string, event: AgentHostEvent) => void
  ) {}

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
    return await (await this.ensureRuntime(projectId)).switchModel(alias, thinking);
  }

  async saveModelConfiguration(projectId: string, input: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot> {
    const managed = this.runtimes.get(projectId);
    if (managed?.runtime.getSnapshot().activeRun || managed?.runtime.getSnapshot().queuedRuns.length) {
      throw new Error("任务运行期间不能修改模型配置。");
    }
    const project = this.projects.requireProject(projectId);
    const current = await loadConfig(project.path);
    const existingProvider = current.providers[input.providerAlias];
    const profile = providerProfile(input.providerType);
    const provider = {
      type: input.providerType,
      baseUrl: input.baseUrl ?? existingProvider?.baseUrl ?? profile.baseUrl,
      apiKey: input.apiKey ?? existingProvider?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existingProvider?.apiKeyEnv ?? profile.apiKeyEnv,
      timeoutMs: existingProvider?.timeoutMs
    };
    const models = Object.fromEntries(Object.entries(current.models).filter(([alias, model]) => (
      alias === input.alias || model.provider !== input.providerAlias || model.model !== input.model
    )));
    const next = configSchema.parse({
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
      thinking: { enabled: input.supportsThinking, effort: "high" }
    });
    await saveConfig(project.path, next);
    this.runtimeErrors.delete(projectId);
    if (managed) {
      managed.unsubscribe();
      await managed.runtime.close();
      this.runtimes.delete(projectId);
    }
    return await this.workspaceSnapshot(projectId);
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
    const runtime = await createInteractiveAgentRuntime(project.path);
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

  private projectEvents(projectId: string): Map<string, AgentHostEvent[]> {
    const current = this.liveEvents.get(projectId);
    if (current) return current;
    const events = new Map<string, AgentHostEvent[]>();
    this.liveEvents.set(projectId, events);
    return events;
  }
}

function isMissingSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Session not found:") || message.startsWith("Session file not found:");
}

function withAttachmentReferences(input: string, attachments: DesktopAttachment[]): string {
  if (!attachments.length) return input;
  return [
    input,
    "",
    "Attached files (workspace-relative paths):",
    ...attachments.map((attachment) => `- ${attachment.path} (${attachment.mimeType || "unknown type"}, ${String(attachment.size)} bytes)`)
  ].join("\n");
}
