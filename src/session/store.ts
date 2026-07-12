/**
 * Session 存储定位模块。
 *
 * `.agent/sessions` 和 `.agent/logs` 的目录创建、session 文件名生成、latest 解析以及 session id
 * 前缀匹配都在这里处理。命令层只需要给出 workspace 和可选 session 参数，不必关心文件布局。
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, pathExists } from "../utils/fs.js";

export function agentDir(workspaceRoot: string): string {
  // 所有 agent 运行产物集中放在工作区 .agent 下，方便清理和忽略。
  return path.join(workspaceRoot, ".agent");
}

export async function ensureAgentDirs(workspaceRoot: string): Promise<void> {
  // 启动 runtime 前确保 sessions/logs 存在，后续 recorder 可以直接打开文件。
  await ensureDir(path.join(agentDir(workspaceRoot), "sessions"));
  await ensureDir(path.join(agentDir(workspaceRoot), "logs"));
}

export function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  // sessionId 不带扩展名，落盘时统一追加 .jsonl。
  return path.join(agentDir(workspaceRoot), "sessions", `${sessionId}.jsonl`);
}

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

export async function listSessionFiles(workspaceRoot: string): Promise<string[]> {
  // 只列出 JSONL session，避免 logs 或临时文件混进恢复列表。
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
  // latest 基于修改时间而不是文件名，能覆盖恢复后继续追加的旧 session。
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
  // 允许 lat/lates/latest 这类前缀，兼顾命令行输入效率和可读性。
  return "latest".startsWith(session) && session.length >= 3;
}
