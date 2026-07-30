/**
 * 配置读写边界。
 *
 * 运行时只依赖这个接口，不直接读文件：CLI/TUI 与 Electron 都通过全局配置和统一凭据存储
 * 获取模型设置，项目覆盖由 workspaceRoot 决定。
 */
import { loadConfig, saveConfig, type ConfigPathOptions } from "./loader.js";
import {
  applyStoredCredentials,
  createCredentialStore,
  saveStoredCredentials,
  type CredentialStore
} from "./credentials.js";
import type { AgentConfig } from "./schema.js";

/** 运行时面向的配置存储接口。 */
export interface AgentConfigStore {
  load(workspaceRoot?: string): Promise<AgentConfig>;
  save(config: AgentConfig, workspaceRoot?: string): Promise<void>;
  /** 当前进程内成功写入配置的版本号；runtime 用它避免每次 prompt 都重新读盘。 */
  revision?(): number;
}

export interface FileConfigStoreOptions {
  credentialStore?: CredentialStore;
  globalDir?: string;
}

export function createFileConfigStore(workspaceRoot: string, options: FileConfigStoreOptions = {}): AgentConfigStore {
  const credentials = options.credentialStore ?? createCredentialStore();
  const pathOptions: ConfigPathOptions = { globalDir: options.globalDir };
  let revision = 0;
  return {
    load: async (requestedWorkspaceRoot) => await applyStoredCredentials(
      await loadConfig(requestedWorkspaceRoot ?? workspaceRoot, pathOptions),
      credentials
    ),
    save: async (config, requestedWorkspaceRoot) => {
      const targetRoot = requestedWorkspaceRoot ?? workspaceRoot;
      const previous = await applyStoredCredentials(await loadConfig(targetRoot, pathOptions), credentials);
      await saveStoredCredentials(config, credentials, previous);
      await saveConfig(targetRoot, config, pathOptions);
      revision += 1;
    },
    revision: () => revision
  };
}
