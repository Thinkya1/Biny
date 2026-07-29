/**
 * Biny 配置与全局 agent 数据的路径解析。
 *
 * 模型配置必须脱离工作区共享，BINY_AGENT_DIR 只改变这一个全局根目录；项目会话等运行产物
 * 仍由 session/store.ts 按工作区定位到 `.biny`。
 */
import os from "node:os";
import path from "node:path";

export const BINY_AGENT_DIR_ENV = "BINY_AGENT_DIR";
export const DEFAULT_AGENT_DIR = path.join(".biny", "agent");
export const GLOBAL_CONFIG_FILE = "agent.config.json";
export const PROJECT_SETTINGS_FILE = "settings.json";

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function globalAgentDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.resolve(options.homeDir ?? os.homedir(), DEFAULT_AGENT_DIR);
}

export function globalConfigPath(options: PathEnvironment = {}): string {
  return path.join(globalAgentDir(options), GLOBAL_CONFIG_FILE);
}

export function projectBinyDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".biny");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), PROJECT_SETTINGS_FILE);
}
