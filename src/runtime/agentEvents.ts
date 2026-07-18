import type { AgentRunMode, AgentSessionInfo } from "../agent/AgentSession.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { PermissionGrantScope, PermissionMode } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";

export type AgentRunStatus = "queued" | "thinking" | "running" | "waiting_permission" | "completed" | "aborted" | "failed";
export type RuntimeOperation = "resume" | "compact" | "switch_model" | "refresh_model" | "subagent";

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

export interface AgentRunModel {
  alias: string;
  provider: string;
  label: string;
  reasoning: string;
}

export type AgentHostEvent =
  | RunStartedEvent
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
  | (AgentEventBase & { type: "file.read"; toolCallId: string; path: string; lineStart?: number; lineEnd?: number })
  | (AgentEventBase & { type: "file.changed"; toolCallId: string; path: string; operation: "write" | "edit"; summary?: string })
  | (AgentEventBase & { type: "diff.created"; toolCallId: string; diff: string; path?: string })
  | (AgentEventBase & { type: "context.updated"; context: ContextStatus })
  | (AgentEventBase & { type: "compact.started"; hint?: string })
  | (AgentEventBase & { type: "compact.completed"; summary: string; context: ContextStatus })
  | (AgentEventBase & { type: "run.completed"; durationMs: number; usage?: SessionUsage })
  | (AgentEventBase & { type: "run.aborted"; durationMs: number; reason: string })
  | (AgentEventBase & { type: "run.failed"; durationMs: number; error: string });

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

export interface InteractiveRuntimeSnapshot {
  info: AgentSessionInfo;
  permissionMode: PermissionMode;
  activeOperation?: RuntimeOperation;
  activeRun?: ActiveRunSnapshot;
  pendingPermission?: PendingPermissionSnapshot;
  queuedRuns: Array<Pick<ActiveRunSnapshot, "runId" | "messageId" | "input" | "mode">>;
}
