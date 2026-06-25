/**
 * TUI 类型定义模块。
 *
 * 这里描述界面层使用的消息、工具调用摘要、权限请求、整体状态和权限选择枚举。
 * 这些类型服务于 reducer 与组件渲染，不暴露底层 recorder 或 provider 对象。
 */
import type { RuntimeStatus } from "../runtime/events.js";
import type { ToolInputDisplay } from "../tools/types.js";

export interface TuiMessage {
  // id 用于 Ink 渲染 key，role 决定颜色和标签。
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
  fullTitle?: string;
  fullContent?: string;
}

export interface TuiToolCall {
  // TUI 只保存工具调用摘要，避免把完整结果长期保留在界面状态中。
  id: string;
  messageId?: string;
  tool: string;
  argsSummary: string;
  display?: ToolInputDisplay;
  status: "pending" | "running" | "success" | "failed" | "denied" | "skipped";
  progressSummary?: string;
  resultSummary?: string;
  fullTitle?: string;
  fullContent?: string;
  durationMs?: number;
  outputLines?: number;
  exitCode?: number;
  truncated?: boolean;
}

export interface TuiPermissionRequest {
  // permission 对应 agent loop 发出的单个待确认工具调用。
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

export interface TuiState {
  // TuiState 是 reducer 的完整 UI 状态快照，不直接持有运行时对象。
  cwd: string;
  provider: string;
  modelLabel: string;
  sessionId: string;
  sessionFile: string;
  viewingSessionId?: string;
  status: RuntimeStatus;
  turnStartedAt?: number;
  lastWorkedMs?: number;
  messages: TuiMessage[];
  messageScrollOffset: number;
  followLatest: boolean;
  toolCalls: TuiToolCall[];
  toolDetailsExpanded: boolean;
  permissionDetailsExpanded: boolean;
  permission?: TuiPermissionRequest;
}

export type PermissionChoice =
  | "approve_once"
  | "reject"
  | "approve_command";
