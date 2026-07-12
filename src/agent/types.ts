/** Agent runtime types shared by the SDK-backed session and Ink host. */
import type { AgentConfig } from "../config/schema.js";
import type { LanguageModel, TextStreamPart, ToolSet } from "ai";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { PermissionManager, PermissionPrompt, PermissionResult } from "../permission/PermissionManager.js";
import type { ContextMemory } from "./context/ContextMemory.js";

export type IntentType = "qa" | "read_file" | "write_file" | "edit_file" | "search_files" | "git_diff" | "run_command";

export interface Intent {
  // type 决定 agent loop 后续走问答、工具调用还是权限确认流程。
  type: IntentType;
  // 以下字段按 intent 类型使用，保持可选便于规则识别逐步补齐。
  filePath?: string;
  content?: string;
  query?: string;
  command?: string;
}

// Preserve Agent-facing event names while the shared permission contract lives in permission/.
export type AgentPermissionRequest = PermissionPrompt;
export type AgentPermissionResult = PermissionResult;

/** SDK-native stream plus the small set of Biny lifecycle events that the SDK does not own. */
export type AgentSessionEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "sdk"; part: TextStreamPart<ToolSet> }
  | { type: "tool-started"; toolCallId: string; tool: string; args: unknown; description?: string; display?: ToolInputDisplay }
  | { type: "tool-progress"; toolCallId: string; tool: string; update: ToolUpdate }
  | { type: "permission-requested"; request: AgentPermissionRequest }
  | { type: "permission-result"; request: AgentPermissionRequest; result: AgentPermissionResult }
  | { type: "error"; message: string; recorded?: boolean }
  | { type: "done"; content: string };

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
  abortSignal?: AbortSignal;
}

export type AgentStatus = "thinking" | "running" | "waiting_permission" | "completed" | "error";
