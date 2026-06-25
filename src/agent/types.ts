/**
 * Agent 类型定义模块。
 *
 * 这里描述 agent loop 与外部运行时之间的契约：识别出的用户意图、权限请求结构，以及执行
 * 一轮任务所需的配置、LLM、工具注册表、session recorder 和事件出口。
 */
import type { AgentConfig } from "../config/schema.js";
import type { ChatMessage, LLMProvider, LLMToolCall } from "../llm/provider.js";
import type { ProjectContext } from "../project/ProjectContext.js";
import type { RuntimeEventSink } from "../runtime/events.js";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { PermissionGrantScope, PermissionManager, PermissionMode, PermissionRequestContext } from "../permission/PermissionManager.js";

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

export interface AgentPermissionRequest extends PermissionRequestContext {
  // 权限请求包含 UI 展示所需的标题、详情和可选 diff。
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
  preview?: string;
}

export interface AgentPermissionResult {
  approved: boolean;
  scope?: PermissionGrantScope;
  nextMode?: PermissionMode;
  message?: string;
}

export interface AgentRuntimeContext {
  // Agent loop 的所有外部依赖都由 runtime 注入，方便 CLI 和 TUI 复用同一套执行逻辑。
  workspaceRoot: string;
  config: AgentConfig;
  llm: LLMProvider;
  recorder: SessionRecorder;
  projectContext: ProjectContext;
  toolRegistry: ToolRegistry;
  permissionManager?: PermissionManager;
  conversation?: ChatMessage[];
  eventSink?: RuntimeEventSink;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  abortSignal?: AbortSignal;
}

export type AgentLoopStatus = "thinking" | "running" | "waiting_permission" | "completed" | "error";

export type AgentLoopEvent =
  | { type: "status"; status: AgentLoopStatus }
  | { type: "assistant_delta"; content: string }
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; call: LLMToolCall; description?: string; display?: ToolInputDisplay }
  | { type: "tool_progress"; toolCallId: string; tool: string; update: ToolUpdate }
  | { type: "tool_result"; toolCallId: string; tool: string; result: unknown }
  | { type: "permission_request"; request: AgentPermissionRequest }
  | { type: "permission_result"; request: AgentPermissionRequest; result: AgentPermissionResult }
  | { type: "error"; message: string }
  | { type: "done"; content: string };
