import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, pathExists } from "../utils/fs.js";

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

export async function listSessionFiles(workspaceRoot: string): Promise<string[]> {
  const sessionsDir = path.join(agentDir(workspaceRoot), "sessions");
  const entries = await fs.readdir(sessionsDir);
  return entries.filter((entry) => entry.endsWith(".jsonl")).sort();
}

export async function resolveSessionFile(workspaceRoot: string, session: string | undefined): Promise<string> {
  // resume 不传参数，或输入 latest/lates/lat 这类前缀时，都读取最近修改的 session。
  if (!session || isLatestAlias(session)) {
    return latestSessionFile(workspaceRoot);
  }

  if (session.includes("/") || session.endsWith(".jsonl")) {
    const filePath = path.resolve(workspaceRoot, session);
    if (await pathExists(filePath)) return filePath;
    throw new Error(`Session file not found: ${path.relative(workspaceRoot, filePath)}`);
  }

  const exact = sessionFilePath(workspaceRoot, session);
  if (await pathExists(exact)) return exact;

  const sessions = await listSessionFiles(workspaceRoot);
  const prefixMatches = sessions.filter((fileName) => fileName.startsWith(session));
  // 支持用 session id 前缀恢复，减少复制完整文件名的成本；如果前缀不唯一就明确报错。
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0];
    if (!match) throw new Error(`Session not found: ${session}`);
    return path.join(agentDir(workspaceRoot), "sessions", match);
  }

  if (prefixMatches.length > 1) {
    throw new Error(`Session id is ambiguous: ${session}\nMatches:\n${prefixMatches.join("\n")}`);
  }

  throw new Error(`Session not found: ${session}\nUse "biny sessions" to list sessions, or "biny resume latest" for the latest session.`);
}

async function latestSessionFile(workspaceRoot: string): Promise<string> {
  const sessions = await listSessionFiles(workspaceRoot);
  if (!sessions.length) throw new Error("No sessions found in .agent/sessions.");
  const sessionsDir = path.join(agentDir(workspaceRoot), "sessions");
  const stats = await Promise.all(
    sessions.map(async (fileName) => ({
      fileName,
      mtimeMs: (await fs.stat(path.join(sessionsDir, fileName))).mtimeMs
    }))
  );
  // 按 mtime 判断 latest，避免同一秒创建多个 session 时文件名排序不准确。
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs || a.fileName.localeCompare(b.fileName));
  const latest = stats.at(-1);
  if (!latest) throw new Error("No sessions found in .agent/sessions.");
  return path.join(sessionsDir, latest.fileName);
}

function isLatestAlias(session: string): boolean {
  return "latest".startsWith(session) && session.length >= 3;
}
