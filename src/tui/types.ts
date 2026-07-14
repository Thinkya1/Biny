/**
 * TUI 类型定义模块。
 *
 * 这里描述界面层使用的消息、工具调用摘要、权限请求、整体状态和权限选择枚举。
 * 这些类型服务于 reducer 与组件渲染，不暴露底层 recorder 或 provider 对象。
 */
import type { RuntimeStatus } from "../runtime/events.js";
import type { ToolInputDisplay } from "../tools/types.js";

interface TranscriptItemBase {
  id: string;
}

export interface UserTranscriptItem extends TranscriptItemBase {
  kind: "user";
  content: string;
}

export interface AssistantTranscriptItem extends TranscriptItemBase {
  kind: "assistant";
  content: string;
}

export interface NotificationTranscriptItem extends TranscriptItemBase {
  kind: "notification";
  content: string;
  tone?: "muted" | "success" | "warning";
}

export interface ErrorTranscriptItem extends TranscriptItemBase {
  kind: "error";
  content: string;
}

export type ToolTranscriptStatus = "pending" | "running" | "success" | "failed" | "denied" | "skipped";

export interface ToolTranscriptItem extends TranscriptItemBase {
  kind: "tool";
  toolCallId?: string;
  tool: string;
  description?: string;
  title: string;
  argsSummary: string;
  display?: ToolInputDisplay;
  status: ToolTranscriptStatus;
  startedAtMs?: number;
  progress?: string;
  output?: string;
  details?: string;
  durationMs?: number;
  outputLines?: number;
  exitCode?: number;
  truncated?: boolean;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | NotificationTranscriptItem
  | ErrorTranscriptItem;

export type ActiveTranscriptItem = AssistantTranscriptItem | ToolTranscriptItem;

export interface TranscriptState {
  // committed 只保存已完成单元；active 中的 assistant/tool 允许按 id 原地更新。
  committed: TranscriptItem[];
  active: ActiveTranscriptItem[];
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
  reasoningLabel: string;
  sessionId: string;
  sessionFile: string;
  viewingSessionId?: string;
  status: RuntimeStatus;
  turnStartedAt?: number;
  lastWorkedMs?: number;
  transcript: TranscriptState;
  permissionDetailsExpanded: boolean;
  permission?: TuiPermissionRequest;
}

export type PermissionChoice =
  | "approve_once"
  | "reject"
  | "approve_command";
