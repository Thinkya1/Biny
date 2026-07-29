import type { AgentRunMode, AgentSessionInfo } from "../agent/AgentSession.js";
import type { AgentTurnStopReason } from "../agent/types.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { PermissionGrantScope, PermissionMode } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";

export type AgentRunStatus = "queued" | "thinking" | "running" | "waiting_permission" | "completed" | "incomplete" | "aborted" | "failed";
export type RuntimeOperation =
  | "resume"
  | "compact"
  | "switch_model"
  | "refresh_model"
  | "subagent"
  | "mcp"
  | "permission"
  | "memory"
  | "model_catalog";

export interface AgentEventBase {
  sessionId: string;
  runId: string;
  timestamp: string;
}

export interface RunStartedEvent extends AgentEventBase {
  type: "run.started";
  messageId: string;
  input: string;
  mode: AgentRunMode;
  model: AgentRunModel;
  skills: string[];
}

export interface RunQueuedEvent extends AgentEventBase {
  type: "run.queued";
  messageId: string;
  input: string;
  mode: AgentRunMode;
  position: number;
  queueLength: number;
}

export interface AgentRunModel {
  alias: string;
  provider: string;
  label: string;
  reasoning: string;
}

export type AgentHostEvent =
  | RunStartedEvent
  | RunQueuedEvent
  | (AgentEventBase & { type: "run.queue.updated"; queueLength: number })
  | (AgentEventBase & { type: "message.user"; messageId: string; content: string })
  | (AgentEventBase & { type: "assistant.delta"; messageId: string; content: string })
  | (AgentEventBase & { type: "assistant.completed"; messageId: string; content: string })
  | (AgentEventBase & { type: "reasoning.started"; messageId: string; status: string })
  | (AgentEventBase & { type: "reasoning.delta"; messageId: string; content: string })
  | (AgentEventBase & { type: "reasoning.status"; messageId: string; status: string })
  | (AgentEventBase & { type: "reasoning.completed"; messageId: string; status: string })
  | (AgentEventBase & { type: "tool.started"; toolCallId: string; tool: string; args: unknown; description?: string; display?: ToolInputDisplay })
  | (AgentEventBase & { type: "tool.progress"; toolCallId: string; tool: string; update: ToolUpdate })
  | (AgentEventBase & { type: "tool.completed"; toolCallId: string; tool: string; result: unknown; durationMs?: number })
  | (AgentEventBase & { type: "tool.failed"; toolCallId: string; tool: string; error: string; durationMs?: number })
  | (AgentEventBase & { type: "permission.requested"; requestId: string; toolCallId: string; request: AgentPermissionEventRequest })
  | (AgentEventBase & { type: "permission.resolved"; requestId: string; toolCallId: string; tool: string; approved: boolean; scope?: PermissionGrantScope; message?: string })
  | (AgentEventBase & { type: "command.started"; toolCallId: string; command: string; cwd?: string })
  | (AgentEventBase & { type: "command.output"; toolCallId: string; stream: "stdout" | "stderr" | "status"; content: string })
  | (AgentEventBase & { type: "command.completed"; toolCallId: string; command: string; cwd?: string; exitCode?: number; durationMs?: number })
  | (AgentEventBase & { type: "command.failed"; toolCallId: string; command: string; cwd?: string; exitCode?: number; status?: string; error: string; durationMs?: number })
  | (AgentEventBase & { type: "file.read"; toolCallId: string; path: string; lineStart?: number; lineEnd?: number })
  | (AgentEventBase & { type: "file.changed"; toolCallId: string; path: string; operation: "write" | "edit"; summary?: string })
  | (AgentEventBase & { type: "diff.created"; toolCallId: string; diff: string; path?: string })
  | (AgentEventBase & { type: "context.updated"; context: ContextStatus })
  | (AgentEventBase & { type: "compact.started"; hint?: string })
  | (AgentEventBase & { type: "compact.completed"; summary: string; context: ContextStatus })
  | (AgentEventBase & { type: "run.completed"; durationMs: number; stopReason?: "model_stop"; finishReason?: string; steps?: number; usage?: SessionUsage })
  | (AgentEventBase & { type: "run.incomplete"; durationMs: number; reason: string; stopReason: AgentTurnStopReason; finishReason?: string; steps: number; usage?: SessionUsage })
  | (AgentEventBase & { type: "run.aborted"; durationMs: number; reason: string; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number })
  | (AgentEventBase & { type: "run.failed"; durationMs: number; error: string; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number });

export interface AgentPermissionEventRequest {
  toolCallId: string;
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
  preview?: string;
  actionType: string;
  riskLevel: string;
  targetPath?: string;
  command?: string;
  reason?: string;
  changeSummary?: string;
}

export interface PendingPermissionSnapshot {
  sessionId: string;
  runId: string;
  requestId: string;
  toolCallId: string;
  request: AgentPermissionEventRequest;
}

export interface ActiveRunSnapshot {
  sessionId: string;
  runId: string;
  messageId: string;
  input: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  startedAt: string;
}

export type QueuedRunSnapshot = Pick<ActiveRunSnapshot, "runId" | "messageId" | "input" | "mode">;

/** InteractiveAgentRuntime 是实时运行状态的唯一所有者；界面只消费这个闭合状态。 */
export type InteractiveRunState =
  | { kind: "idle" }
  | {
    kind: "runs";
    activeRun?: ActiveRunSnapshot;
    queuedRuns: QueuedRunSnapshot[];
    pendingPermission?: PendingPermissionSnapshot;
  }
  | { kind: "maintenance"; operation: RuntimeOperation }
  | { kind: "background_subagent"; count: number };

export interface InteractiveRuntimeSnapshot {
  revision: number;
  info: AgentSessionInfo;
  permissionMode: PermissionMode;
  state: InteractiveRunState;
}

/** Runtime 发布的唯一实时信封；没有 event 时表示维护操作等纯状态变化。 */
export interface AgentRuntimeUpdate {
  event?: AgentHostEvent;
  snapshot: InteractiveRuntimeSnapshot;
}

export function activeRun(snapshot: InteractiveRuntimeSnapshot | undefined): ActiveRunSnapshot | undefined {
  return snapshot?.state.kind === "runs" ? snapshot.state.activeRun : undefined;
}

export function queuedRuns(snapshot: InteractiveRuntimeSnapshot | undefined): QueuedRunSnapshot[] {
  return snapshot?.state.kind === "runs" ? snapshot.state.queuedRuns : [];
}

export function pendingPermission(snapshot: InteractiveRuntimeSnapshot | undefined): PendingPermissionSnapshot | undefined {
  return snapshot?.state.kind === "runs" ? snapshot.state.pendingPermission : undefined;
}

export function runtimeIsBusy(snapshot: InteractiveRuntimeSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.state.kind !== "idle";
}

/** 仅供 InteractiveAgentRuntime 更新自己的闭合状态，客户端不得重复实现生命周期。 */
export function reduceInteractiveRunState(
  state: InteractiveRunState,
  event: AgentHostEvent
): InteractiveRunState {
  const currentRuns = state.kind === "runs"
    ? state
    : { kind: "runs" as const, queuedRuns: [] };
  if (event.type === "run.queued") {
    const queued = currentRuns.queuedRuns.filter((run) => run.runId !== event.runId);
    queued.push({ runId: event.runId, messageId: event.messageId, input: event.input, mode: event.mode });
    return { ...currentRuns, queuedRuns: queued };
  }
  if (event.type === "run.queue.updated") return state;
  if (event.type === "run.started") {
    return {
      kind: "runs",
      activeRun: {
        sessionId: event.sessionId,
        runId: event.runId,
        messageId: event.messageId,
        input: event.input,
        mode: event.mode,
        status: "thinking",
        startedAt: event.timestamp
      },
      queuedRuns: currentRuns.queuedRuns.filter((run) => run.runId !== event.runId)
    };
  }
  if (
    event.type === "reasoning.started"
    || event.type === "reasoning.delta"
    || event.type === "reasoning.status"
  ) {
    return updateActiveRunStatus(currentRuns, event.runId, "thinking");
  }
  if (
    event.type === "tool.started"
    || event.type === "tool.progress"
    || event.type === "tool.completed"
    || event.type === "tool.failed"
  ) {
    return updateActiveRunStatus(currentRuns, event.runId, "running");
  }
  if (event.type === "permission.requested") {
    return {
      ...updateActiveRunStatus(currentRuns, event.runId, "waiting_permission"),
      pendingPermission: {
        sessionId: event.sessionId,
        runId: event.runId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        request: event.request
      }
    };
  }
  if (event.type === "permission.resolved") {
    if (currentRuns.pendingPermission?.requestId !== event.requestId) return state;
    return { ...updateActiveRunStatus(currentRuns, event.runId, "running"), pendingPermission: undefined };
  }
  if (
    event.type === "run.completed"
    || event.type === "run.incomplete"
    || event.type === "run.aborted"
    || event.type === "run.failed"
  ) {
    const queued = currentRuns.queuedRuns.filter((run) => run.runId !== event.runId);
    const nextActive = currentRuns.activeRun?.runId === event.runId ? undefined : currentRuns.activeRun;
    return nextActive || queued.length
      ? { kind: "runs", activeRun: nextActive, queuedRuns: queued }
      : { kind: "idle" };
  }
  return state;
}

function updateActiveRunStatus(
  state: Extract<InteractiveRunState, { kind: "runs" }>,
  runId: string,
  status: AgentRunStatus
): Extract<InteractiveRunState, { kind: "runs" }> {
  if (state.activeRun?.runId !== runId) return state;
  return { ...state, activeRun: { ...state.activeRun, status } };
}
