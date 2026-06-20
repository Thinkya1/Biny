import type { RuntimeEvent } from "../runtime/events.js";
import type { TuiState, TuiToolCall } from "./types.js";

export function createInitialTuiState(workspaceRoot: string): TuiState {
  return {
    cwd: workspaceRoot,
    provider: "MockProvider",
    modelLabel: "mock",
    sessionId: "",
    sessionFile: "",
    viewingSessionId: undefined,
    status: "idle",
    turnStartedAt: undefined,
    lastWorkedMs: undefined,
    messages: [{ id: "welcome", role: "system", content: "BinyAgent TUI 已启动。输入 / 查看命令，Enter 发送，/exit 退出。" }],
    messageScrollOffset: 0,
    followLatest: true,
    toolCalls: [],
    toolDetailsExpanded: false,
    permissionDetailsExpanded: false
  };
}

export function tuiReducer(state: TuiState, event: RuntimeEvent): TuiState {
  switch (event.type) {
    case "session.started":
      return { ...state, cwd: event.cwd, provider: event.provider, modelLabel: event.modelLabel ?? event.provider, sessionId: event.sessionId, sessionFile: event.sessionFile, viewingSessionId: event.sessionId, status: "idle", turnStartedAt: undefined, lastWorkedMs: undefined };
    case "session.completed":
      return {
        ...state,
        status: "completed",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined
      };
    case "session.error":
      return {
        ...state,
        status: "error",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        messages: appendMessage(state, "error", event.message)
      };
    case "system.message":
      return { ...state, messages: appendMessage(state, "system", event.content) };
    case "messages.cleared":
      return { ...state, messages: [], messageScrollOffset: 0, followLatest: true };
    case "messages.replaced":
      return {
        ...state,
        viewingSessionId: event.viewingSessionId,
        messages: event.messages.map((message, index) => ({ ...message, id: `loaded-${String(index + 1)}` })),
        messageScrollOffset: 0,
        followLatest: true,
        turnStartedAt: undefined,
        lastWorkedMs: undefined
      };
    case "messages.scrolled":
      return {
        ...state,
        followLatest: false,
        messageScrollOffset: Math.max(0, state.messageScrollOffset + event.direction * (event.amount ?? 1))
      };
    case "messages.follow_latest":
      return { ...state, followLatest: true, messageScrollOffset: 0 };
    case "tool.details.toggled":
      return { ...state, toolDetailsExpanded: !state.toolDetailsExpanded };
    case "permission.details.toggled":
      return { ...state, permissionDetailsExpanded: !state.permissionDetailsExpanded };
    case "user.message":
      return { ...state, viewingSessionId: state.sessionId, status: "thinking", turnStartedAt: Date.now(), lastWorkedMs: undefined, messages: appendMessage(state, "user", event.content) };
    case "assistant.delta":
      return { ...state, status: "thinking", messages: appendAssistantDelta(state, event.content) };
    case "assistant.completed":
      return { ...state, status: "completed", messages: completeAssistantMessage(state, event.content) };
    case "tool.call.started":
      return { ...state, status: "running", toolCalls: appendToolCall(state, event.tool, summarize(event.args)) };
    case "tool.call.completed":
      return { ...state, status: "running", toolCalls: finishLatestToolCall(state, event.tool, "success", summarize(event.result)) };
    case "tool.call.failed":
      return { ...state, status: "error", toolCalls: finishLatestToolCall(state, event.tool, "failed", event.error) };
    case "permission.requested":
      return {
        ...state,
        status: "waiting_permission",
        permission: {
          tool: event.tool,
          title: event.title,
          details: event.details,
          requireFullYes: event.requireFullYes,
          diff: event.diff
        }
      };
    case "permission.approved":
      return { ...state, status: "running", permission: undefined };
    case "permission.rejected":
      return {
        ...state,
        status: "completed",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined
      };
  }
}

function appendMessage(state: TuiState, role: "user" | "assistant" | "system" | "error", content: string) {
  return [...state.messages, { id: `${role}-${String(state.messages.length + 1)}`, role, content }];
}

function appendAssistantDelta(state: TuiState, content: string) {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant") {
    return [...state.messages.slice(0, -1), { ...last, content: `${last.content}${content}` }];
  }
  return appendMessage(state, "assistant", content);
}

function completeAssistantMessage(state: TuiState, content: string) {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant") {
    return [...state.messages.slice(0, -1), { ...last, content }];
  }
  return appendMessage(state, "assistant", content);
}

function appendToolCall(state: TuiState, tool: string, argsSummary: string): TuiToolCall[] {
  const call: TuiToolCall = { id: `${tool}-${String(state.toolCalls.length + 1)}`, tool, argsSummary, status: "running" };
  return [...state.toolCalls, call].slice(-80);
}

function finishLatestToolCall(state: TuiState, tool: string, status: "success" | "failed", resultSummary: string): TuiToolCall[] {
  const next = [...state.toolCalls];
  for (let index = next.length - 1; index >= 0; index--) {
    const item = next[index];
    if (item && item.tool === tool && item.status === "running") {
      next[index] = { ...item, status, resultSummary };
      return next;
    }
  }
  return [...next, { id: `${tool}-${String(next.length + 1)}`, tool, argsSummary: "", status, resultSummary }].slice(-80);
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}
