/**
 * Ink host adapter over the shared InteractiveAgentRuntime. TUI components see
 * the existing RuntimeEvent contract while Desktop consumes AgentHostEvent
 * directly from the same runtime.
 */
import type { AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../../agent/AgentSession.js";
import type { ContextStatus } from "../../agent/context/types.js";
import type { ExtensionSection } from "../../extensions/report.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../permission/PermissionManager.js";
import { createInteractiveAgentRuntime } from "../../runtime/InteractiveAgentRuntime.js";
import type { SubagentTaskSnapshot } from "../../runtime/SubagentTaskManager.js";
import type { RuntimeEventSink } from "../../runtime/events.js";
import type { SessionSummary } from "../../session/events.js";
import type { PermissionChoice } from "../types.js";
import { agentEventToRuntimeEvents } from "./agentEventAdapter.js";
import { TuiEventBridge } from "./eventBridge.js";

export interface TuiRuntime {
  getInfo(): AgentSessionInfo;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  runPermissionCommand(args: string[]): Promise<string>;
  listModels(): ModelChoice[];
  switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo>;
  refreshModelFromDisk(): Promise<ModelRuntimeInfo>;
  sendPrompt(prompt: string, mode?: AgentRunMode): Promise<void>;
  resumeSession(session: string): Promise<ResumedAgentSession>;
  listSessions(): Promise<SessionSummary[]>;
  extensionReport(section?: ExtensionSection): string;
  runSubagentTask(task: string): Promise<string>;
  listSubagentTasks(): SubagentTaskSnapshot[];
  cancelSubagentTask(taskId: string, reason?: string): boolean;
  contextReport(): Promise<string>;
  usageReport(): string;
  contextStatus(): Promise<ContextStatus>;
  compactConversation(hint?: string): Promise<string>;
  cancelCurrentTurn(): void;
  answerPermission(choice: PermissionChoice): void;
  subscribe(listener: RuntimeEventSink): () => void;
  close(): Promise<void>;
}

export async function createTuiRuntime(workspaceRoot: string): Promise<TuiRuntime> {
  const bridge = new TuiEventBridge();
  const host = await createInteractiveAgentRuntime(workspaceRoot);
  const unsubscribeHost = host.subscribe((event) => {
    for (const runtimeEvent of agentEventToRuntimeEvents(event)) bridge.emit(runtimeEvent);
  });
  let closePromise: Promise<void> | undefined;
  const emitModelChanged = (info: ModelRuntimeInfo): void => {
    bridge.emit({
      type: "model.changed",
      provider: info.provider,
      modelLabel: info.modelLabel,
      reasoningLabel: info.reasoningLabel
    });
  };

  return {
    getInfo(): AgentSessionInfo {
      return host.getInfo();
    },
    getPermissionMode(): PermissionMode {
      return host.getPermissionMode();
    },
    async setPermissionMode(mode: PermissionMode): Promise<void> {
      await host.setPermissionMode(mode);
    },
    async runPermissionCommand(args: string[]): Promise<string> {
      return await host.runPermissionCommand(args);
    },
    listModels(): ModelChoice[] {
      return host.listModels();
    },
    async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
      const info = await host.switchModel(alias, thinking);
      emitModelChanged(info);
      return info;
    },
    async refreshModelFromDisk(): Promise<ModelRuntimeInfo> {
      const info = await host.refreshModelFromDisk();
      emitModelChanged(info);
      return info;
    },
    async sendPrompt(prompt: string, mode: AgentRunMode = "chat"): Promise<void> {
      const info = await host.refreshModelFromDisk();
      emitModelChanged(info);
      await host.submitPrompt(prompt, mode).completion;
    },
    async resumeSession(session: string): Promise<ResumedAgentSession> {
      const resumed = await host.resumeSession(session);
      const info = host.getInfo();
      bridge.emit({
        type: "session.started",
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        cwd: info.workspaceRoot,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
      return resumed;
    },
    async listSessions(): Promise<SessionSummary[]> {
      return await host.listSessions();
    },
    extensionReport(section?: ExtensionSection): string {
      return host.extensionReport(section);
    },
    async runSubagentTask(task: string): Promise<string> {
      return await host.runSubagentTask(task);
    },
    listSubagentTasks(): SubagentTaskSnapshot[] {
      return host.listSubagentTasks();
    },
    cancelSubagentTask(taskId: string, reason?: string): boolean {
      return host.cancelSubagentTask(taskId, reason);
    },
    async contextReport(): Promise<string> {
      return await host.contextReport();
    },
    usageReport(): string {
      return host.usageReport();
    },
    async contextStatus(): Promise<ContextStatus> {
      return await host.contextStatus();
    },
    async compactConversation(hint?: string): Promise<string> {
      return await host.compactConversation(hint);
    },
    cancelCurrentTurn(): void {
      host.cancelCurrentRun();
    },
    answerPermission(choice: PermissionChoice): void {
      const pending = host.getSnapshot().pendingPermission;
      if (!pending) return;
      host.answerPermission(pending.requestId, permissionChoiceToResult(choice, pending.request.requireFullYes));
    },
    subscribe(listener: RuntimeEventSink): () => void {
      return bridge.subscribe(listener);
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        unsubscribeHost();
        await host.close();
      })();
      return closePromise;
    }
  };
}

export function permissionChoiceToResult(choice: PermissionChoice, requireFullYes: boolean): PermissionResult {
  if (choice === "approve_once") return { approved: true, scope: "once", confirmation: requireFullYes ? "yes" : undefined };
  if (choice === "approve_command") return { approved: true, scope: "command", confirmation: requireFullYes ? "yes" : undefined };
  return { approved: false, scope: "once", message: "Denied by user.", confirmation: undefined };
}
