import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, listSessionFiles } from "./store.js";
import type { SessionEvent } from "./recorder.js";

export interface SessionSummary {
  fileName: string;
  firstUserMessage: string;
  eventCount: number;
  createdAt: string;
}

export async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line, index) => parseSessionEvent(line, index + 1));
}

export async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const fileNames = await listSessionFiles(workspaceRoot);
  const sessionsDir = path.join(agentDir(workspaceRoot), "sessions");
  // sessions 命令只做轻量摘要：文件名、首条用户消息、事件数和创建时间。
  const summaries = await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(sessionsDir, fileName);
      const [events, stat] = await Promise.all([readSessionEvents(filePath), fs.stat(filePath)]);
      const firstUserMessage = events.find((event) => event.type === "user_message")?.content ?? "";
      const firstTime = events.find((event) => typeof event.time === "string")?.time;
      return {
        fileName,
        firstUserMessage,
        eventCount: events.length,
        createdAt: firstTime ?? stat.birthtime.toISOString()
      };
    })
  );
  return summaries.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function parseSessionEvent(line: string, lineNumber: number): SessionEvent {
  try {
    return JSON.parse(line) as SessionEvent;
  } catch (error) {
    throw new Error(`Invalid JSONL event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
