import { runAgentTask } from "../../agent/loop.js";
import type { AgentPermissionRequest, AgentPermissionResult } from "../../agent/types.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import type { RuntimeEventSink } from "../../runtime/events.js";
import { SessionRecorder } from "../../session/recorder.js";
import { sessionIdFromFile } from "../sessionTranscript.js";
import type { PermissionChoice } from "../types.js";
import { TuiEventBridge } from "./eventBridge.js";

export interface TuiRuntime {
  readonly commandRuntime: CommandRuntime;
  sendPrompt(prompt: string): Promise<void>;
  resumeSession(filePath: string): Promise<void>;
  cancelCurrentTurn(): void;
  answerPermission(choice: PermissionChoice): void;
  subscribe(listener: RuntimeEventSink): () => void;
  close(): Promise<void>;
}

export async function createTuiRuntime(workspaceRoot: string): Promise<TuiRuntime> {
  const bridge = new TuiEventBridge();
  const commandRuntime = await createCommandRuntime(workspaceRoot);
  let pendingPermission: ((result: AgentPermissionResult) => void) | undefined;
  let queuedPermissionChoice: PermissionChoice | undefined;
  let autoAllowTurn = false;
  let busy = false;
  let abortController: AbortController | undefined;
  let closePromise: Promise<void> | undefined;

  bridge.emit({
    type: "session.started",
    sessionId: commandRuntime.recorder.sessionId,
    sessionFile: commandRuntime.recorder.filePath,
    cwd: commandRuntime.workspaceRoot,
    provider: commandRuntime.config.model.provider,
    modelLabel: formatModelLabel(commandRuntime.config.model.provider, commandRuntime.config.model.model)
  });

  return {
    commandRuntime,
    async sendPrompt(prompt: string): Promise<void> {
      if (busy) return;
      busy = true;
      autoAllowTurn = false;
      abortController = new AbortController();
      try {
        await runAgentTask(prompt, {
          ...commandRuntime,
          abortSignal: abortController.signal,
          eventSink: (event) => bridge.emit(event),
          confirmPermission: async (request) => {
            if (autoAllowTurn) return { approved: true, scope: "turn" };
            return await waitForPermission(request);
          }
        });
        bridge.emit({ type: "session.completed", sessionId: commandRuntime.recorder.sessionId });
      } catch (error) {
        if (abortController.signal.aborted) {
          commandRuntime.recorder.record({ type: "error", message: "Current turn interrupted." });
          bridge.emit({ type: "system.message", content: "当前轮次已中断。" });
          bridge.emit({ type: "session.completed", sessionId: commandRuntime.recorder.sessionId });
          return;
        }
        bridge.emit({
          type: "session.error",
          sessionId: commandRuntime.recorder.sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        busy = false;
        abortController = undefined;
        pendingPermission = undefined;
      }
    },
    async resumeSession(filePath: string): Promise<void> {
      if (busy) throw new Error("Cannot resume another session while a turn is running.");
      await commandRuntime.recorder.close();
      commandRuntime.recorder = new SessionRecorder(commandRuntime.workspaceRoot, sessionIdFromFile(filePath));
      bridge.emit({
        type: "session.started",
        sessionId: commandRuntime.recorder.sessionId,
        sessionFile: commandRuntime.recorder.filePath,
        cwd: commandRuntime.workspaceRoot,
        provider: commandRuntime.config.model.provider,
        modelLabel: formatModelLabel(commandRuntime.config.model.provider, commandRuntime.config.model.model)
      });
    },
    cancelCurrentTurn(): void {
      if (!busy || !abortController) return;
      abortController.abort();
      if (pendingPermission) {
        pendingPermission({ approved: false, scope: "once" });
        pendingPermission = undefined;
      }
    },
    answerPermission(choice: PermissionChoice): void {
      if (!pendingPermission) {
        queuedPermissionChoice = choice;
        return;
      }
      if (choice === "approve_turn") autoAllowTurn = true;
      const approved = choice !== "reject";
      pendingPermission({ approved, scope: choice === "approve_turn" ? "turn" : "once" });
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
      if (choice === "approve_turn") autoAllowTurn = true;
      return { approved: choice !== "reject", scope: choice === "approve_turn" ? "turn" : "once" };
    }
    return await new Promise<AgentPermissionResult>((resolve) => {
      pendingPermission = resolve;
    });
  }
}

function formatModelLabel(provider: string, model: string): string {
  if (!model || model === provider) return provider;
  return `${provider}/${model}`;
}
