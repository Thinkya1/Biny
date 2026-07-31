/** AgentSession 对外发布的规范化运行事件。 */
import type { AgentConfig } from "../config/schema.js";
import type { AgentModel } from "./core/types.js";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { PermissionManager, PermissionPrompt, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ContextMemory } from "./context/ContextMemory.js";

// Preserve Agent-facing event names while the shared permission contract lives in permission/.
export type AgentPermissionRequest = PermissionPrompt;
export type AgentPermissionResult = PermissionResult;

export type AgentTurnStatus = "completed" | "incomplete" | "blocked" | "cancelled" | "failed" | "aborted";

/**
 * AgentSession 的终止原因。新普通 Loop 用 completion_gate / hard_step_limit /
 * no_progress_after_continuation 等结构化原因；step_limit、tool_pending、model_stop 和
 * aborted 仅保留给旧宿主与历史 Session 事件兼容。
 */
export type AgentTurnStopReason =
  | "model_stop"
  | "completion_gate"
  | "step_limit"
  | "hard_step_limit"
  | "tool_call_limit"
  | "completion_continuation_limit"
  | "no_progress_after_continuation"
  | "repeated_action_limit"
  | "tool_pending"
  | "timeout"
  | "verification_failed"
  | "model_length"
  | "content_filter"
  | "provider_error"
  | "blocked"
  | "cancelled"
  | "aborted"
  | "budget_exhausted";

/** 一个统一模型/工具回合的结构化终态；只有 Completion Gate 能产生 completed。 */
export interface AgentTurnOutcome {
  status: AgentTurnStatus;
  stopReason: AgentTurnStopReason;
  finishReason?: string;
  steps: number;
  output: string;
  usage?: SessionUsage;
  error?: string;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  affectedTodoIds?: string[];
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

/** Provider 原始分片在 Session 内归一化，宿主不需要理解 provider wire 协议。 */
export type AgentSessionEvent =
  | { type: "status"; status: AgentStatus }
  | AgentSessionUpdate
  | { type: "error"; message: string; recorded?: boolean; fatal?: boolean }
  | { type: "done"; content: string; usage?: SessionUsage; outcome: AgentTurnOutcome };

export interface AgentRuntimeContext {
  // Agent loop 的所有外部依赖都由 runtime 注入，方便 CLI 和 TUI 复用同一套执行逻辑。
  workspaceRoot: string;
  config: AgentConfig;
  model?: AgentModel;
  recorder: SessionRecorder;
  contextMemory?: ContextMemory;
  toolRegistry: ToolRegistry;
  permissionManager?: PermissionManager;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  /** 回合内首次改动工作区前建快照；未提供或抛错时工具照常执行。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  /** 工具第一次获得可写资源后、真正执行前捕获 Completion Gate 的事实基线。 */
  beforeWorkspaceMutation?: () => Promise<void>;
  quarantineExternalTool?: (tool: string, toolCallId: string, settlement: Promise<unknown>) => void;
  abortSignal?: AbortSignal;
}

export type AgentStatus =
  | "thinking"
  | "running"
  | "waiting_permission"
  | "completed"
  | "incomplete"
  | "blocked"
  | "cancelled"
  | "aborted"
  | "error";
