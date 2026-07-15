/**
 * Session 事件读取模块。
 *
 * Session 文件是一行一个 JSON 事件。这里负责把 JSONL 解析成事件数组，并从中提取首条用户消息、
 * 最后一条 assistant 消息、事件数量和时间信息，供 `sessions` 列表与历史恢复界面使用。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, listSessionFiles } from "./store.js";
import type { SessionEvent } from "./recorder.js";

export interface SessionSummary {
  fileName: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  // session 文件采用 JSONL，一行一个事件；空行忽略，坏行带行号报错。
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
      if (!events.some((event) => event.type === "user_message")) return undefined;
      const firstUserMessage = events.find((event) => event.type === "user_message")?.content ?? "";
      const lastAssistant = [...events].reverse().find((event): event is Extract<SessionEvent, { type: "assistant_message" }> => event.type === "assistant_message" && Boolean(event.content));
      const lastAssistantMessage = lastAssistant?.content ?? "";
      const firstTime = events.find((event) => typeof event.time === "string")?.time;
      const lastTime = [...events].reverse().find((event) => typeof event.time === "string")?.time;
      return {
        fileName,
        firstUserMessage,
        lastAssistantMessage,
        eventCount: events.length,
        createdAt: firstTime ?? stat.birthtime.toISOString(),
        updatedAt: lastTime ?? stat.mtime.toISOString()
      };
    })
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== undefined).sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function parseSessionEvent(line: string, lineNumber: number): SessionEvent {
  // 单独封装解析错误，resume/sessions 命令可以直接显示具体损坏位置。
  try {
    return JSON.parse(line) as SessionEvent;
  } catch (error) {
    throw new Error(`Invalid JSONL event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
