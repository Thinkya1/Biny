/**
 * TUI 状态归约模块。
 *
 * Runtime 事件会在这里转换成可渲染的界面状态：消息列表、工具调用摘要、权限请求、滚动状态和轮次耗时。
 * reducer 保持纯函数，不读写文件，也不持有 runtime 对象。
 */
import type { RuntimeEvent } from "../runtime/events.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { formatDiffPreviewLines, renderDiffLinesClustered, renderFileContentPreview } from "./diffPreview.js";
import type { TuiState, TuiToolCall } from "./types.js";
import { summarizeToolOutput } from "./toolOutputSummary.js";

export function createInitialTuiState(workspaceRoot: string): TuiState {
  // 初始状态先显示欢迎消息；真正 session 信息会在 runtime 创建完成后覆盖。
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
  // reducer 保持纯函数，只根据事件更新 UI 状态，不直接访问 runtime 或文件系统。
  switch (event.type) {
    case "session.started":
      // 新 session 或 resume 后都会重置运行中状态，但保留消息由调用方决定。
      return { ...state, cwd: event.cwd, provider: event.provider, modelLabel: event.modelLabel ?? event.provider, sessionId: event.sessionId, sessionFile: event.sessionFile, viewingSessionId: event.sessionId, status: "idle", turnStartedAt: undefined, lastWorkedMs: undefined };
    case "session.completed":
      // 完成事件负责计算本轮耗时，并清掉可能残留的权限请求。
      return {
        ...state,
        status: "completed",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined
      };
    case "session.error":
      // 运行时错误既更新状态，也追加一条 error 消息到 transcript。
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
      return { ...state, messages: [], toolCalls: [], messageScrollOffset: 0, followLatest: true };
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
      // 用户手动滚动后停止自动跟随最新消息，直到显式按 End。
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
      // 用户消息标志新一轮开始，后续 assistant delta 会接在 transcript 末尾。
      return { ...state, viewingSessionId: state.sessionId, status: "thinking", turnStartedAt: Date.now(), lastWorkedMs: undefined, messages: appendMessage(state, "user", event.content) };
    case "assistant.delta":
      return { ...state, status: "thinking", messages: appendAssistantDelta(state, event.content) };
    case "assistant.completed":
      return { ...state, status: "completed", messages: completeAssistantMessage(state, event.content) };
    case "tool.call.started": {
      const next = appendToolCall(state, event.toolCallId, event.tool, summarizeToolArgs(event.tool, event.args), event.display);
      return { ...state, status: "running", toolCalls: next.toolCalls, messages: next.messages };
    }
    case "tool.call.progress": {
      const next = updateToolProgress(state, event.toolCallId, event.tool, summarizeToolProgress(event.update));
      return { ...state, status: "running", toolCalls: next.toolCalls, messages: next.messages };
    }
    case "tool.call.completed": {
      const next = finishLatestToolCall(state, event.toolCallId, event.tool, resultStatus(event.result), event.result);
      return { ...state, status: "running", toolCalls: next.toolCalls, messages: next.messages };
    }
    case "tool.call.failed": {
      const next = finishLatestToolCall(state, event.toolCallId, event.tool, "failed", event.error);
      return { ...state, status: "error", toolCalls: next.toolCalls, messages: next.messages };
    }
    case "permission.requested":
      // 权限请求会冻结输入框，并由 PermissionPrompt 接管 y/n/a 快捷键。
      return {
        ...state,
        status: "waiting_permission",
        permission: {
          tool: event.tool,
          title: event.title,
          details: event.details,
          requireFullYes: event.requireFullYes,
          diff: event.diff,
          preview: event.preview,
          actionType: event.actionType,
          riskLevel: event.riskLevel,
          targetPath: event.targetPath,
          command: event.command,
          reason: event.reason,
          changeSummary: event.changeSummary
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
    case "permission.status.changed":
      return { ...state, messages: appendMessage(state, "system", event.message) };
  }
}

function appendMessage(state: TuiState, role: "user" | "assistant" | "system" | "error", content: string) {
  // 简单用消息数量生成稳定 id；session reload 会重新生成 loaded-* id。
  return [...state.messages, { id: `${role}-${String(state.messages.length + 1)}`, role, content }];
}

function appendAssistantDelta(state: TuiState, content: string) {
  // 流式输出时持续修改最后一条 assistant 消息；没有 assistant 时新建一条。
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant") {
    return [...state.messages.slice(0, -1), { ...last, content: `${last.content}${content}` }];
  }
  return appendMessage(state, "assistant", content);
}

function completeAssistantMessage(state: TuiState, content: string) {
  // complete 事件用最终文本覆盖流式累积内容，确保 session 和 UI 一致。
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant") {
    return [...state.messages.slice(0, -1), { ...last, content }];
  }
  return appendMessage(state, "assistant", content);
}

function appendToolCall(state: TuiState, toolCallId: string | undefined, tool: string, argsSummary: string, display: ToolInputDisplay | undefined): { toolCalls: TuiToolCall[]; messages: TuiState["messages"] } {
  // 只保留最近 80 条工具调用，防止长会话造成界面状态无限增长。
  const id = toolCallId ?? `${tool}-${String(state.toolCalls.length + 1)}`;
  const call: TuiToolCall = { id, messageId: `tool-message-${id}`, tool, argsSummary, display, status: "running" };
  return {
    toolCalls: [...state.toolCalls, call].slice(-80),
    messages: [...state.messages, { id: call.messageId ?? id, role: "system", content: formatToolCallMessage(call) }]
  };
}

function updateToolProgress(
  state: TuiState,
  toolCallId: string | undefined,
  tool: string,
  progressSummary: string
): { toolCalls: TuiToolCall[]; messages: TuiState["messages"] } {
  const next = [...state.toolCalls];
  const index = findToolCallIndex(next, toolCallId, tool);
  if (index === -1) return { toolCalls: next, messages: state.messages };
  const item = next[index];
  if (!item) return { toolCalls: next, messages: state.messages };
  const updated = { ...item, progressSummary };
  next[index] = updated;
  return { toolCalls: next, messages: updateToolMessage(state.messages, updated) };
}

function finishLatestToolCall(
  state: TuiState,
  toolCallId: string | undefined,
  tool: string,
  status: TuiToolCall["status"],
  result: unknown
): { toolCalls: TuiToolCall[]; messages: TuiState["messages"] } {
  // 从后往前找同名 running 调用，处理并发或重复工具名时最贴近最近事件。
  const next = [...state.toolCalls];
  const meta = toolResultMeta(result);
  const index = findToolCallIndex(next, toolCallId, tool);
  if (index !== -1) {
    const item = next[index];
    if (item) {
      const output = summarizeToolOutput(tool, result, item.argsSummary, item.display);
      const updated = { ...item, status, resultSummary: output.summary, fullTitle: output.fullTitle, fullContent: output.fullContent, ...meta };
      next[index] = updated;
      return { toolCalls: next, messages: updateToolMessage(state.messages, updated) };
    }
  }
  const id = toolCallId ?? `${tool}-${String(next.length + 1)}`;
  const output = summarizeToolOutput(tool, result, "", undefined);
  const call: TuiToolCall = { id, messageId: `tool-message-${id}`, tool, argsSummary: "", status, resultSummary: output.summary, fullTitle: output.fullTitle, fullContent: output.fullContent, ...meta };
  return {
    toolCalls: [...next, call].slice(-80),
    messages: [...state.messages, { id: call.messageId ?? id, role: "system", content: formatToolCallMessage(call) }]
  };
}

function findToolCallIndex(toolCalls: TuiToolCall[], toolCallId: string | undefined, tool: string): number {
  if (toolCallId) {
    const index = toolCalls.findIndex((item) => item.id === toolCallId);
    if (index !== -1) return index;
  }
  for (let index = toolCalls.length - 1; index >= 0; index--) {
    const item = toolCalls[index];
    if (item && item.tool === tool && item.status === "running") return index;
  }
  return -1;
}

function summarizeValue(value: unknown): string {
  // 工具参数和结果在 UI 中只显示短摘要，完整内容仍保存在 session JSONL。
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const output = record.output;
    if (typeof output === "string") return output.slice(0, 4000);
  }
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function summarizeToolArgs(tool: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : undefined;
  const query = typeof record.query === "string" ? record.query : undefined;
  const command = typeof record.command === "string" ? record.command : undefined;

  if (tool === "read_file" && path) return path;
  if (tool === "write_file" && path) return path;
  if (tool === "edit_file" && path) return path;
  if ((tool === "search_files" || tool === "grep_search") && query) return `searching "${query}"`;
  if (tool === "list_files") return "listing workspace files";
  if (tool === "git_status") return "git status --short";
  if (tool === "git_diff") return "git diff";
  if (tool === "run_command" && command) return command;
  return summarizeValue(args);
}

function summarizeToolProgress(update: { kind: string; text?: string; percent?: number }): string {
  const percent = update.percent === undefined ? "" : `${String(update.percent)}% `;
  const text = update.text ?? update.kind;
  return `${percent}${text}`.slice(0, 240);
}

function resultStatus(result: unknown): TuiToolCall["status"] {
  if (typeof result === "object" && result !== null && "status" in result && result.status === "denied") return "denied";
  if (typeof result === "object" && result !== null && "error" in result) return "failed";
  return "success";
}

function toolResultMeta(result: unknown): Pick<TuiToolCall, "durationMs" | "outputLines" | "exitCode" | "truncated"> {
  if (typeof result !== "object" || result === null) return {};
  const record = result as Record<string, unknown>;
  return {
    durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    outputLines: typeof record.outputLines === "number" ? record.outputLines : undefined,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
    truncated: typeof record.truncated === "boolean" ? record.truncated : undefined
  };
}

function updateToolMessage(messages: TuiState["messages"], call: TuiToolCall): TuiState["messages"] {
  const messageId = call.messageId;
  if (!messageId) return messages;
  return messages.map((message) => message.id === messageId ? { ...message, content: formatToolCallMessage(call), fullTitle: call.fullTitle, fullContent: call.fullContent } : message);
}

function formatToolCallMessage(call: TuiToolCall): string {
  const meta = [
    call.durationMs === undefined ? undefined : `${String(call.durationMs)}ms`,
    call.outputLines === undefined ? undefined : `${String(call.outputLines)} output lines`,
    call.exitCode === undefined ? undefined : `exit ${String(call.exitCode)}`,
    call.truncated ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const progress = call.progressSummary && call.status === "running" ? `\n  progress: ${call.progressSummary}` : "";
  const preview = call.display?.kind === "command" && call.status !== "running" ? "" : formatDisplayPreview(call.display);
  const result = call.resultSummary && !shouldHideResultSummaryAfterPreview(call, preview)
    ? formatResultSummary(call.resultSummary)
    : "";
  const suffix = meta ? ` (${meta})` : "";
  return `${statusSymbol(call.status)} ${toolIcon(call.tool)} ${call.tool}: ${call.argsSummary}${suffix}${progress}${preview}${result}`;
}

function shouldHideResultSummaryAfterPreview(call: TuiToolCall, preview: string): boolean {
  return preview.length > 0 && call.display?.kind === "file_io" && isBlockSummary(call.resultSummary ?? "");
}

function formatDisplayPreview(display: ToolInputDisplay | undefined): string {
  if (!display) return "";
  if (display.kind === "file_io" && display.operation === "write" && display.path && typeof display.content === "string") {
    return `\n${formatDiffPreviewLines(renderFileContentPreview(display.path, display.content, { maxLines: 12 }))}`;
  }
  if (display.kind === "file_io" && display.operation === "edit" && display.path && typeof display.before === "string" && typeof display.after === "string") {
    return `\n${formatDiffPreviewLines(renderDiffLinesClustered(display.before, display.after, display.path, { contextLines: 3, maxLines: 12 }))}`;
  }
  if (display.kind === "command") {
    return `\n  $ ${display.command}`;
  }
  return "";
}

function formatResultSummary(summary: string): string {
  if (isBlockSummary(summary)) return `\n${summary}`;
  return `\n  result: ${summary}`;
}

function isBlockSummary(summary: string): boolean {
  return /^(Created|Edited|Deleted|Read|Write) /.test(summary) || /^(?:\+\d+\s+)?-\d+\s+\S/.test(summary) || /^\+\d+\s+\S/.test(summary);
}

function statusSymbol(status: TuiToolCall["status"]): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "denied") return "⊘";
  if (status === "skipped") return "↷";
  return "…";
}

function toolIcon(tool: string): string {
  if (tool === "search_files" || tool === "grep_search") return "🔍";
  if (tool === "read_file" || tool === "list_files" || tool === "git_status" || tool === "git_diff") return "📖";
  if (tool === "write_file" || tool === "edit_file") return "✏️";
  if (tool === "run_command") return "💻";
  return "•";
}
