import type { AgentConfig } from "../config/schema.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ProjectContext } from "../project/ProjectContext.js";
import type { RuntimeEventSink } from "../runtime/events.js";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolName } from "../permission/policy.js";

export type IntentType = "qa" | "read_file" | "write_file" | "edit_file" | "search_files" | "run_command";

export interface Intent {
  type: IntentType;
  filePath?: string;
  content?: string;
  query?: string;
  command?: string;
}

export interface AgentPermissionRequest {
  tool: ToolName;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
}

export interface AgentPermissionResult {
  approved: boolean;
  scope?: "once" | "turn";
}

export interface AgentRuntimeContext {
  workspaceRoot: string;
  config: AgentConfig;
  llm: LLMProvider;
  recorder: SessionRecorder;
  projectContext: ProjectContext;
  toolRegistry: ToolRegistry;
  eventSink?: RuntimeEventSink;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  abortSignal?: AbortSignal;
}
