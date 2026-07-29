/**
 * Biny 配置与全局 agent 数据的路径解析。
 *
 * 模型配置和项目会话都脱离工作区存放。BINY_AGENT_DIR 改变这一个全局根目录；项目设置及
 * 附件、记忆等其余运行产物仍保留在项目 `.biny`。
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
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

/** 项目会话按规范化绝对路径隔离，避免不同工作区的 latest、id 前缀和锁互相干扰。 */
export function projectSessionsDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  const projectId = createHash("sha256")
    .update(path.resolve(workspaceRoot))
    .digest("hex")
    .slice(0, 24);
  const configuredRoot = globalAgentDir(options);
  const canonicalRoot = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
  return path.join(canonicalRoot, "sessions", projectId);
}

export function projectBinyDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".biny");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), PROJECT_SETTINGS_FILE);
}
