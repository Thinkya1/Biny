import { loadConfig, saveConfig } from "./loader.js";
import type { AgentConfig } from "./schema.js";

/**
 * Runtime-facing configuration boundary. CLI uses the file implementation,
 * while desktop can keep credentials out of its readable settings file.
 */
export interface AgentConfigStore {
  load(): Promise<AgentConfig>;
  save(config: AgentConfig): Promise<void>;
}

export function createFileConfigStore(workspaceRoot: string): AgentConfigStore {
  return {
    load: async () => await loadConfig(workspaceRoot),
    save: async (config) => await saveConfig(workspaceRoot, config)
  };
}
