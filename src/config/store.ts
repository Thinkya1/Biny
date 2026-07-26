/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI 用文件实现，桌面端可以换成把 key 存在系统
 * 凭据里、配置文件中不落明文的实现。
 */
import { loadConfig, saveConfig } from "./loader.js";
import type { AgentConfig } from "./schema.js";

/** 运行时面向的配置存储接口。 */
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
