import path from "node:path";
import { ensureDir } from "../utils/fs.js";

export function agentDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent");
}

export async function ensureAgentDirs(workspaceRoot: string): Promise<void> {
  await ensureDir(path.join(agentDir(workspaceRoot), "sessions"));
  await ensureDir(path.join(agentDir(workspaceRoot), "logs"));
}

export function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  return path.join(agentDir(workspaceRoot), "sessions", `${sessionId}.jsonl`);
}
