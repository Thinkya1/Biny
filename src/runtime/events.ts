export type RuntimeStatus = "idle" | "thinking" | "running" | "waiting_permission" | "completed" | "error";

export type RuntimeEvent =
  | { type: "session.started"; sessionId: string; sessionFile: string; cwd: string; provider: string; modelLabel?: string }
  | { type: "session.completed"; sessionId: string }
  | { type: "session.error"; sessionId?: string; message: string }
  | { type: "system.message"; content: string }
  | { type: "messages.cleared" }
  | { type: "messages.replaced"; messages: Array<{ role: "user" | "assistant" | "system" | "error"; content: string }>; viewingSessionId?: string }
  | { type: "messages.scrolled"; direction: -1 | 1; amount?: number }
  | { type: "messages.follow_latest" }
  | { type: "tool.details.toggled" }
  | { type: "permission.details.toggled" }
  | { type: "user.message"; content: string }
  | { type: "assistant.delta"; content: string }
  | { type: "assistant.completed"; content: string }
  | { type: "tool.call.started"; tool: string; args: unknown }
  | { type: "tool.call.completed"; tool: string; result: unknown }
  | { type: "tool.call.failed"; tool: string; error: string }
  | { type: "permission.requested"; tool: string; title: string; details: string; requireFullYes: boolean; diff?: string }
  | { type: "permission.approved"; tool: string; scope: "once" | "turn" }
  | { type: "permission.rejected"; tool: string };

export type RuntimeEventSink = (event: RuntimeEvent) => void;
