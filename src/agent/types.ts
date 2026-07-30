/** AgentSession 对外发布的规范化运行事件。 */
import type { AgentConfig } from "../config/schema.js";
import type { LanguageModel } from "ai";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { PermissionManager, PermissionPrompt, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ContextMemory } from "./context/ContextMemory.js";

// Preserve Agent-facing event names while the shared permission contract lives in permission/.
export type AgentPermissionRequest = PermissionPrompt;
export type AgentPermissionResult = PermissionResult;

export type AgentTurnStatus = "completed" | "incomplete" | "failed" | "aborted";

/**
 * Why one bounded AgentSession attempt stopped. `step_limit` and
 * `tool_pending` are deliberately non-success terminal reasons: callers may
 * continue them through the task harness, but must never present them as a
 * completed task.
 */
export type AgentTurnStopReason =
  | "model_stop"
  | "step_limit"
  | "tool_pending"
  | "timeout"
  | "verification_failed"
  | "model_length"
  | "content_filter"
  | "provider_error"
  | "aborted"
  | "budget_exhausted";

/** Structured result for a single bounded model/tool turn. */
export interface AgentTurnOutcome {
  status: AgentTurnStatus;
  stopReason: AgentTurnStopReason;
  finishReason?: string;
  steps: number;
  output: string;
  usage?: SessionUsage;
  error?: string;
}

export type AgentSessionUpdate =
  | { type: "assistant.delta"; content: string }
  | { type: "assistant.completed"; content: string }
  | { type: "reasoning.started"; phase: "initial" | "continuing" }
  | { type: "reasoning.delta"; content: string }
  | { type: "reasoning.completed" }
  | AgentToolEvent;

export type AgentToolEvent =
  | { type: "tool.started"; toolCallId: string; tool: string; args: unknown; description?: string; display?: ToolInputDisplay }
  | { type: "tool.progress"; toolCallId: string; tool: string; update: ToolUpdate }
  | { type: "tool.completed"; toolCallId: string; tool: string; result: unknown; durationMs?: number }
  | { type: "tool.failed"; toolCallId: string; tool: string; error: string; result?: unknown; durationMs?: number };

/** Provider 原始分片在 Session 内归一化，宿主不需要理解 AI SDK 协议。 */
export type AgentSessionEvent =
  | { type: "status"; status: AgentStatus }
  | AgentSessionUpdate
  | { type: "error"; message: string; recorded?: boolean; fatal?: boolean }
  | { type: "done"; content: string; usage?: SessionUsage; outcome: AgentTurnOutcome };

export interface AgentRuntimeContext {
  // Agent loop 的所有外部依赖都由 runtime 注入，方便 CLI 和 TUI 复用同一套执行逻辑。
  workspaceRoot: string;
  config: AgentConfig;
  /** Canonical Vercel AI SDK model used by ToolLoopAgent and SDK helpers. */
  model: LanguageModel;
  recorder: SessionRecorder;
  contextMemory?: ContextMemory;
  toolRegistry: ToolRegistry;
  permissionManager?: PermissionManager;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  /** 回合内首次改动工作区前建快照；未提供或抛错时工具照常执行。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  quarantineExternalTool?: (tool: string, toolCallId: string, settlement: Promise<unknown>) => void;
  abortSignal?: AbortSignal;
}

export type AgentStatus = "thinking" | "running" | "waiting_permission" | "completed" | "incomplete" | "aborted" | "error";
