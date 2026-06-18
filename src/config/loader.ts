import { promises as fs } from "node:fs";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "./schema.js";

export const CONFIG_FILE = "agent.config.json";

export async function loadConfig(workspaceRoot: string): Promise<AgentConfig> {
  const filePath = path.join(workspaceRoot, CONFIG_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return defaultConfig;
    throw new Error(`Failed to load ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function ensureConfig(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, CONFIG_FILE);
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
