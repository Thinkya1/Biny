/**
 * TUI host bridge. Ink consumes agent events through this narrow interface and
 * never reaches into the provider, tool registry, recorder or context state.
 */
import type { AgentSessionInfo, ResumedAgentSession } from "../../agent/AgentSession.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentSessionEvent } from "../../agent/types.js";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../../llm/ModelManager.js";
import { createCommandRuntime } from "../../runtime/CommandRuntime.js";
import type { RuntimeEventSink } from "../../runtime/events.js";
import type { SessionSummary } from "../../session/events.js";
import type { ContextStatus } from "../../agent/context/types.js";
import type { PermissionChoice } from "../types.js";
import { TuiEventBridge } from "./eventBridge.js";

export interface TuiRuntime {
  getInfo(): AgentSessionInfo;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  runPermissionCommand(args: string[]): Promise<string>;
  listModels(): ModelChoice[];
  switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo>;
  sendPrompt(prompt: string): Promise<void>;
  createPlan(task: string): Promise<void>;
  resumeSession(session: string): Promise<ResumedAgentSession>;
  listSessions(): Promise<SessionSummary[]>;
  contextReport(): Promise<string>;
  contextStatus(): Promise<ContextStatus>;
  compactConversation(hint?: string): Promise<string>;
  cancelCurrentTurn(): void;
  answerPermission(choice: PermissionChoice): void;
  subscribe(listener: RuntimeEventSink): () => void;
  close(): Promise<void>;
}

export async function createTuiRuntime(workspaceRoot: string): Promise<TuiRuntime> {
  const bridge = new TuiEventBridge();
  const commandRuntime = await createCommandRuntime(workspaceRoot);
  const agent = commandRuntime.agent;
  let pendingPermission: ((result: AgentPermissionResult) => void) | undefined;
  let queuedPermissionChoice: PermissionChoice | undefined;
  let busy = false;
  let abortController: AbortController | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    getInfo(): AgentSessionInfo {
      return agent.getInfo();
    },
    getPermissionMode(): PermissionMode {
      return agent.getPermissionMode();
    },
    async setPermissionMode(mode: PermissionMode): Promise<void> {
      await agent.setPermissionMode(mode);
    },
    async runPermissionCommand(args: string[]): Promise<string> {
      return await agent.runPermissionCommand(args);
    },
    listModels(): ModelChoice[] {
      return agent.listModels();
    },
    async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
      if (busy) throw new Error("Cannot switch models while a turn is running.");
      const info = await agent.switchModel(alias, thinking);
      bridge.emit({
        type: "model.changed",
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
      return info;
    },
    async sendPrompt(prompt: string): Promise<void> {
      if (busy) return;
      busy = true;
      abortController = new AbortController();
      try {
        bridge.emit({ type: "user.message", content: prompt });
        for await (const event of agent.runSdk(prompt, {
          abortSignal: abortController.signal,
          confirmPermission: async (request) => await waitForPermission(request)
        })) {
          bridgeAgentSessionEvent(event);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          agent.recordError(new Error("Current turn interrupted."));
          bridge.emit({ type: "system.message", content: "当前轮次已中断。" });
          bridge.emit({ type: "session.completed", sessionId: agent.getInfo().sessionId });
          return;
        }
        bridge.emit({
          type: "session.error",
          sessionId: agent.getInfo().sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        busy = false;
        abortController = undefined;
        pendingPermission = undefined;
      }
    },
    async createPlan(task: string): Promise<void> {
      if (busy) return;
      busy = true;
      bridge.emit({ type: "user.message", content: `/plan ${task}` });
      try {
        const output = await agent.createPlan(task, (delta) => bridge.emit({ type: "assistant.delta", content: delta }));
        bridge.emit({ type: "assistant.completed", content: output });
        bridge.emit({ type: "session.completed", sessionId: agent.getInfo().sessionId });
      } catch (error) {
        bridge.emit({
          type: "session.error",
          sessionId: agent.getInfo().sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        busy = false;
      }
    },
    async resumeSession(session: string): Promise<ResumedAgentSession> {
      if (busy) throw new Error("Cannot resume another session while a turn is running.");
      const resumed = await agent.resume(session);
      const info = agent.getInfo();
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
      return await agent.listSessions();
    },
    async contextReport(): Promise<string> {
      return await agent.contextReport();
    },
    async contextStatus(): Promise<ContextStatus> {
      return await agent.contextStatus();
    },
    async compactConversation(hint?: string): Promise<string> {
      return await agent.compactConversation(hint);
    },
    cancelCurrentTurn(): void {
      if (!busy || !abortController) return;
      abortController.abort();
      if (pendingPermission) {
        pendingPermission({ approved: false, scope: "once", message: "Current turn interrupted." });
        pendingPermission = undefined;
      }
    },
    answerPermission(choice: PermissionChoice): void {
      if (!pendingPermission) {
        queuedPermissionChoice = choice;
        return;
      }
      pendingPermission(permissionChoiceToResult(choice));
      pendingPermission = undefined;
    },
    subscribe(listener: RuntimeEventSink): () => void {
      return bridge.subscribe(listener);
    },
    close(): Promise<void> {
      closePromise ??= commandRuntime.close();
      return closePromise;
    }
  };

  async function waitForPermission(_request: AgentPermissionRequest): Promise<AgentPermissionResult> {
    if (queuedPermissionChoice !== undefined) {
      const choice = queuedPermissionChoice;
      queuedPermissionChoice = undefined;
      return permissionChoiceToResult(choice);
    }
    return await new Promise<AgentPermissionResult>((resolve) => {
      pendingPermission = resolve;
    });
  }

  function bridgeAgentSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "status") {
      bridge.emit({ type: "runtime.status", status: event.status });
      return;
    }
    if (event.type === "sdk") {
      const part = event.part;
      if (part.type === "text-delta") {
        bridge.emit({ type: "assistant.delta", content: part.text });
      } else if (part.type === "tool-result") {
        bridge.emit({ type: "tool.call.completed", toolCallId: part.toolCallId, tool: part.toolName, result: part.output });
      } else if (part.type === "tool-error") {
        bridge.emit({ type: "tool.call.failed", toolCallId: part.toolCallId, tool: part.toolName, error: String(part.error) });
      }
      return;
    }
    if (event.type === "tool-started") {
      bridge.emit({ type: "tool.call.started", toolCallId: event.toolCallId, tool: event.tool, args: event.args, description: event.description, display: event.display });
      return;
    }
    if (event.type === "tool-progress") {
      bridge.emit({ type: "tool.call.progress", toolCallId: event.toolCallId, tool: event.tool, update: event.update });
      return;
    }
    if (event.type === "permission-requested") {
      bridge.emit({
        type: "permission.requested",
        tool: event.request.tool,
        title: event.request.title,
        details: event.request.details,
        requireFullYes: event.request.requireFullYes,
        diff: event.request.diff,
        preview: event.request.preview,
        actionType: event.request.actionType,
        riskLevel: event.request.riskLevel,
        targetPath: event.request.targetPath,
        command: event.request.command,
        reason: event.request.reason,
        changeSummary: event.request.changeSummary
      });
      return;
    }
    if (event.type === "permission-result") {
      bridge.emit(event.result.approved
        ? { type: "permission.approved", tool: event.request.tool, scope: event.result.scope ?? "once" }
        : { type: "permission.rejected", tool: event.request.tool, reason: event.result.message });
      return;
    }
    if (event.type === "error") {
      bridge.emit({ type: "error.message", message: event.message });
      return;
    }
    if (event.type === "done") {
      if (event.content) bridge.emit({ type: "assistant.completed", content: event.content });
      bridge.emit({ type: "session.completed", sessionId: agent.getInfo().sessionId });
    }
  }
}

function permissionChoiceToResult(choice: PermissionChoice): AgentPermissionResult {
  if (choice === "approve_once") return { approved: true, scope: "once" };
  if (choice === "approve_command") return { approved: true, scope: "command" };
  return { approved: false, scope: "once", message: "Denied by user." };
}
