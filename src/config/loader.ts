/**
 * 配置加载模块。
 *
 * 这里封装 `agent.config.json` 的读取、zod 校验和初始化写入。缺失配置时会回退到默认值，
 * 但只要文件存在且解析失败，就把错误显式抛给命令层，避免使用半有效配置启动 agent。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "./schema.js";

export const CONFIG_FILE = "agent.config.json";

export async function loadConfig(workspaceRoot: string): Promise<AgentConfig> {
  const filePath = path.join(workspaceRoot, CONFIG_FILE);
  try {
    // 配置文件存在时必须通过 zod 校验，避免半有效配置进入运行时。
    const raw = await fs.readFile(filePath, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    // 没有配置文件时使用默认配置；其他读取或解析错误都需要暴露给用户。
    if (isNotFound(error)) return defaultConfig;
    throw new Error(`Failed to load ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(workspaceRoot: string, config: AgentConfig): Promise<void> {
  const filePath = path.join(workspaceRoot, CONFIG_FILE);
  const parsed = configSchema.parse(config);
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function ensureConfig(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, CONFIG_FILE);
  try {
    await fs.access(filePath);
  } catch {
    // init 命令只在缺失时写入默认配置，避免覆盖用户已经调整过的模型设置。
    await fs.writeFile(filePath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  }
}

function isNotFound(error: unknown): boolean {
  // Node 的 fs 错误码在 unknown 上需要显式收窄后才能读取。
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
