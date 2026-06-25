/**
 * TUI 运行时桥接模块。
 *
 * TUI 不直接调用底层 agent loop，而是通过这个 runtime 发送 prompt、取消当前轮次、回答权限请求和恢复 session。
 * 它把 agent 事件广播给 React reducer，并把权限弹窗的用户选择转换回 agent loop 等待的结果。
 */
import { runAgentLoop } from "../../agent/loop.js";
import type { AgentLoopEvent } from "../../agent/types.js";
import type { AgentPermissionRequest, AgentPermissionResult } from "../../agent/types.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import type { RuntimeEventSink } from "../../runtime/events.js";
import { SessionRecorder } from "../../session/recorder.js";
import { sessionIdFromFile } from "../sessionTranscript.js";
import type { PermissionChoice } from "../types.js";
import { TuiEventBridge } from "./eventBridge.js";

export interface TuiRuntime {
  // TUI 只通过这些方法操作 runtime，不直接调用 agent loop 或 recorder。
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
  // pendingPermission 保存当前权限弹窗的 resolver；用户按键后再恢复 agent loop。
  let pendingPermission: ((result: AgentPermissionResult) => void) | undefined;
  let queuedPermissionChoice: PermissionChoice | undefined;
  let busy = false;
  let abortController: AbortController | undefined;
  let closePromise: Promise<void> | undefined;

  bridge.emit({
    // runtime 创建完成后立即通知 UI 当前 session 元信息。
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
      // 同一时间只允许一个 turn，避免 session 记录和权限状态交叉。
      if (busy) return;
      busy = true;
      abortController = new AbortController();
      try {
        bridge.emit({ type: "user.message", content: prompt });
        for await (const event of runAgentLoop(prompt, {
          ...commandRuntime,
          abortSignal: abortController.signal,
          confirmPermission: async (request) => {
            return await waitForPermission(request);
          }
        })) {
          bridgeAgentLoopEvent(event);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          // 用户中断不视为失败，用 system message 告知并结束本轮。
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
      // resume 会切换 recorder 到目标 session，后续新消息继续追加到该文件。
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
      // 取消 turn 时同时拒绝悬挂的权限请求，避免 agent loop 永远等待。
      if (!busy || !abortController) return;
      abortController.abort();
      if (pendingPermission) {
        pendingPermission({ approved: false, scope: "once", message: "Current turn interrupted." });
        pendingPermission = undefined;
      }
    },
    answerPermission(choice: PermissionChoice): void {
      // 如果按键早于 resolver 建立，先缓存一次选择，waitForPermission 会消费它。
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
      // close 保持幂等，避免 React unmount 和显式退出同时关闭 recorder。
      closePromise ??= commandRuntime.close();
      return closePromise;
    }
  };

  async function waitForPermission(_request: AgentPermissionRequest): Promise<AgentPermissionResult> {
    // 权限请求事件已经由 agent loop 发到 UI，这里只负责等待用户选择。
    if (queuedPermissionChoice !== undefined) {
      const choice = queuedPermissionChoice;
      queuedPermissionChoice = undefined;
      return permissionChoiceToResult(choice);
    }
    return await new Promise<AgentPermissionResult>((resolve) => {
      pendingPermission = resolve;
    });
  }

  function bridgeAgentLoopEvent(event: AgentLoopEvent): void {
    if (event.type === "status") return;
    if (event.type === "assistant_delta") {
      bridge.emit({ type: "assistant.delta", content: event.content });
      return;
    }
    if (event.type === "assistant_message") {
      bridge.emit({ type: "assistant.completed", content: event.content });
      return;
    }
    if (event.type === "tool_call") {
      bridge.emit({ type: "tool.call.started", toolCallId: event.call.id, tool: event.call.name, args: event.call.args, description: event.description, display: event.display });
      return;
    }
    if (event.type === "tool_progress") {
      bridge.emit({ type: "tool.call.progress", toolCallId: event.toolCallId, tool: event.tool, update: event.update });
      return;
    }
    if (event.type === "tool_result") {
      bridge.emit({ type: "tool.call.completed", toolCallId: event.toolCallId, tool: event.tool, result: event.result });
      return;
    }
    if (event.type === "permission_request") {
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
    if (event.type === "permission_result") {
      bridge.emit(event.result.approved
        ? { type: "permission.approved", tool: event.request.tool, scope: event.result.scope ?? "once" }
        : { type: "permission.rejected", tool: event.request.tool, reason: event.result.message });
      if (event.result.nextMode) {
        bridge.emit({ type: "permission.status.changed", message: `Permission mode switched to ${event.result.nextMode}.` });
      }
      return;
    }
    if (event.type === "error") {
      bridge.emit({ type: "session.error", sessionId: commandRuntime.recorder.sessionId, message: event.message });
      return;
    }
    bridge.emit({ type: "session.completed", sessionId: commandRuntime.recorder.sessionId });
  }
}

function formatModelLabel(provider: string, model: string): string {
  // model 与 provider 相同或为空时只显示 provider，减少状态栏噪音。
  if (!model || model === provider) return provider;
  return `${provider}/${model}`;
}

function permissionChoiceToResult(choice: PermissionChoice): AgentPermissionResult {
  if (choice === "approve_once") return { approved: true, scope: "once" };
  if (choice === "approve_command") return { approved: true, scope: "command" };
  return { approved: false, scope: "once", message: "Denied by user." };
}
