/**
 * Biny 配置与全局 agent 数据的路径解析。
 *
 * 模型配置、项目会话和项目记忆都脱离工作区存放。配置文件固定在 `~/.biny/config.json`，
 * session/memory 等 Agent 运行数据在 `~/.biny/agent/`；BINY_AGENT_DIR 只改变后者。
 * 项目 `.biny` 只承载设置、扩展覆盖与尚未迁出的运行产物。
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BINY_AGENT_DIR_ENV = "BINY_AGENT_DIR";
export const DEFAULT_AGENT_DIR = path.join(".biny", "agent");
export const GLOBAL_CONFIG_FILE = "config.json";
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
  return path.join(globalConfigDir(options), GLOBAL_CONFIG_FILE);
}

export function globalConfigDir(options: PathEnvironment = {}): string {
  const configured = (options.env ?? process.env)[BINY_AGENT_DIR_ENV];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.dirname(globalAgentDir(options));
}

/** 项目会话按规范化绝对路径隔离，避免不同工作区的 latest、id 前缀和锁互相干扰。 */
export function projectSessionsDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  return projectStateDir("sessions", workspaceRoot, options);
}

/** Memory 保持项目作用域，但物理存储位于全局 agent 目录，避免污染项目工作区。 */
export function projectMemoryDir(workspaceRoot: string, options: PathEnvironment = {}): string {
  return projectStateDir("memory", workspaceRoot, options);
}

function projectStateDir(kind: "sessions" | "memory", workspaceRoot: string, options: PathEnvironment): string {
  const projectId = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 24);
  const configuredRoot = globalAgentDir(options);
  const canonicalRoot = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
  return path.join(canonicalRoot, kind, projectId);
}

export function projectBinyDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".biny");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), PROJECT_SETTINGS_FILE);
}
