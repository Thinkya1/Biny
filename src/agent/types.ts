import type { AgentConfig } from "../config/schema.js";
import type { LLMProvider } from "../llm/provider.js";
import type { SessionRecorder } from "../session/recorder.js";

export type IntentType = "qa" | "read_file" | "edit_file" | "run_command";

export interface Intent {
  type: IntentType;
  filePath?: string;
  command?: string;
}

export interface AgentRuntimeContext {
  workspaceRoot: string;
  config: AgentConfig;
  llm: LLMProvider;
  recorder: SessionRecorder;
}
