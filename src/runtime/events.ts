/**
 * Runtime 事件协议模块。
 *
 * Agent loop、命令运行时和 TUI 之间通过这些事件同步状态，例如用户消息、模型增量、
 * 工具调用、权限请求和 session 完成。界面层只消费事件，不直接窥探运行时内部对象。
 */
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";

export type RuntimeStatus = "idle" | "thinking" | "running" | "waiting_permission" | "completed" | "error";

// RuntimeEvent 是 agent/runtime 到 TUI 的唯一事件协议；UI reducer 只消费这些事件更新状态。
export type RuntimeEvent =
  | { type: "session.started"; sessionId: string; sessionFile: string; cwd: string; provider: string; modelLabel?: string }
  | { type: "session.completed"; sessionId: string }
  | { type: "session.error"; sessionId?: string; message: string }
  | { type: "system.message"; content: string }
  | { type: "messages.cleared" }
  | { type: "messages.replaced"; messages: Array<{ role: "user" | "assistant" | "system" | "error"; content: string; fullTitle?: string; fullContent?: string }>; viewingSessionId?: string }
  | { type: "messages.scrolled"; direction: -1 | 1; amount?: number }
  | { type: "messages.follow_latest" }
  | { type: "tool.details.toggled" }
  | { type: "permission.details.toggled" }
  | { type: "user.message"; content: string }
  | { type: "assistant.delta"; content: string }
  | { type: "assistant.completed"; content: string }
  | { type: "tool.call.started"; toolCallId?: string; tool: string; args: unknown; description?: string; display?: ToolInputDisplay }
  | { type: "tool.call.progress"; toolCallId?: string; tool: string; update: ToolUpdate }
  | { type: "tool.call.completed"; toolCallId?: string; tool: string; result: unknown }
  | { type: "tool.call.failed"; toolCallId?: string; tool: string; error: string }
  | {
    type: "permission.requested";
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
  | { type: "permission.approved"; tool: string; scope: string }
  | { type: "permission.rejected"; tool: string; reason?: string }
  | { type: "permission.status.changed"; message: string };

export type RuntimeEventSink = (event: RuntimeEvent) => void;
