import type { RuntimeStatus } from "../runtime/events.js";

export interface TuiMessage {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  content: string;
}

export interface TuiToolCall {
  id: string;
  tool: string;
  argsSummary: string;
  status: "running" | "success" | "failed";
  resultSummary?: string;
}

export interface TuiPermissionRequest {
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
}

export interface TuiState {
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

export type PermissionChoice = "approve_once" | "approve_turn" | "reject";
