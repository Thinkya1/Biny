/**
 * Session 事件读取模块。
 *
 * Session 文件是一行一个 JSON 事件。这里负责把 JSONL 解析成事件数组，并从中提取首条用户消息、
 * 最后一条 assistant 消息、事件数量和时间信息，供 `sessions` 列表与历史恢复界面使用。
 */
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import {
  maxSessionEventLineBytes,
  maxSessionEvents,
  maxSessionFileBytes,
  readBoundedSessionHandle
} from "./limits.js";
import { listSessionFiles, readSessionSnapshot } from "./store.js";
import type { SessionEvent } from "./recorder.js";

const sessionListReadConcurrency = 8;
const sessionUsageSchema = z.record(z.unknown());
const sessionContextSchema = z.record(z.unknown());
const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    skills: z.array(z.string()).optional(),
    contextUsage: sessionContextSchema.optional(),
    contextState: sessionContextSchema.optional(),
    preparationUsage: z.array(sessionUsageSchema).optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("assistant_message"),
    content: z.string(),
    reasoningContent: z.string().optional(),
    usage: sessionUsageSchema.optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    contextState: sessionContextSchema.optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("tool_call"),
    tool: z.string(),
    args: z.unknown().optional(),
    toolCallId: z.string().optional(),
    sequence: z.number().finite().optional(),
    assistantContent: z.string().optional(),
    reasoningContent: z.string().optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("tool_result"),
    tool: z.string(),
    result: z.unknown().optional(),
    toolCallId: z.string().optional(),
    sequence: z.number().finite().optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    auditOnly: z.boolean().optional(),
    time: z.string().optional()
  }).passthrough(),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    detail: z.unknown().optional(),
    relatedUsage: z.array(sessionUsageSchema).optional(),
    time: z.string().optional()
  }).passthrough()
]);

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
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    await assertStandaloneSessionBinding(filePath, handle);
    const raw = (await readBoundedSessionHandle(handle, filePath)).toString("utf8");
    await assertStandaloneSessionBinding(filePath, handle);
    return parseSessionEvents(raw);
  } finally {
    await handle.close();
  }
}

export async function readStoredSessionEvents(
  workspaceRoot: string,
  session: string | undefined
): Promise<{ filePath: string; events: SessionEvent[] }> {
  const snapshot = await readSessionSnapshot(workspaceRoot, session);
  return { filePath: snapshot.filePath, events: parseSessionEvents(snapshot.bytes.toString("utf8")) };
}

export function parseSessionEvents(raw: string): SessionEvent[] {
  const totalBytes = Buffer.byteLength(raw, "utf8");
  if (totalBytes > maxSessionFileBytes) {
    throw new Error(`Session exceeds the maximum size of ${String(maxSessionFileBytes)} bytes.`);
  }
  const events: SessionEvent[] = [];
  let lineNumber = 0;
  let lineStart = 0;
  while (lineStart <= raw.length) {
    const newlineIndex = raw.indexOf("\n", lineStart);
    const terminated = newlineIndex !== -1;
    const lineEnd = terminated ? newlineIndex : raw.length;
    const line = raw.slice(lineStart, lineEnd);
    lineNumber += 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > maxSessionEventLineBytes) {
      throw new Error(`Session event line ${String(lineNumber)} exceeds the maximum size of ${String(maxSessionEventLineBytes)} bytes.`);
    }
    if (!line) {
      if (!terminated) break;
      lineStart = lineEnd + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!terminated) break;
      throw new Error(`Invalid JSONL event at line ${String(lineNumber)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (events.length >= maxSessionEvents) {
      throw new Error(`Session cannot contain more than ${String(maxSessionEvents)} events.`);
    }
    events.push(validateSessionEvent(parsed, lineNumber));
    if (!terminated) break;
    lineStart = lineEnd + 1;
  }
  return events;
}

/**
 * Makes an existing JSONL session safe for append after an interrupted write.
 * A valid final event only needs a newline; an invalid unterminated fragment is
 * truncated back to the previous complete line.
 */
export async function repairSessionTailForAppend(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, constants.O_RDWR | noFollowFlag());
  try {
    await assertStandaloneSessionBinding(filePath, handle);
    const raw = await readBoundedSessionHandle(handle, filePath);
    await assertStandaloneSessionBinding(filePath, handle);
    if (raw.length === 0 || raw.at(-1) === 0x0a) return;

    const lastNewline = raw.lastIndexOf(0x0a);
    const tail = raw.subarray(lastNewline + 1).toString("utf8");
    try {
      JSON.parse(tail);
      await handle.write("\n", raw.length, "utf8");
    } catch {
      await handle.truncate(lastNewline + 1);
    }
    await assertStandaloneSessionBinding(filePath, handle);
  } finally {
    await handle.close();
  }
}

export async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const fileNames = await listSessionFiles(workspaceRoot);
  // Bound reads so a large history does not create an unbounded file-descriptor
  // burst. A corrupt JSONL file is isolated from the rest of the session list.
  const summaries: Array<SessionSummary | undefined> = new Array(fileNames.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(sessionListReadConcurrency, fileNames.length) }, async () => {
    while (nextIndex < fileNames.length) {
      const index = nextIndex;
      nextIndex += 1;
      const fileName = fileNames[index];
      if (!fileName) continue;
      try {
        const snapshot = await readSessionSnapshot(workspaceRoot, fileName);
        const events = parseSessionEvents(snapshot.bytes.toString("utf8"));
        if (!events.some((event) => event.type === "user_message")) continue;
        const firstUserMessage = events.find((event) => event.type === "user_message")?.content ?? "";
        const lastAssistant = [...events].reverse().find((event): event is Extract<SessionEvent, { type: "assistant_message" }> => event.type === "assistant_message" && Boolean(event.content));
        const lastAssistantMessage = lastAssistant?.content ?? "";
        const firstTime = events.find((event) => typeof event.time === "string")?.time;
        const lastTime = [...events].reverse().find((event) => typeof event.time === "string")?.time;
        summaries[index] = {
          fileName,
          firstUserMessage,
          lastAssistantMessage,
          eventCount: events.length,
          createdAt: firstTime ?? snapshot.stat.birthtime.toISOString(),
          updatedAt: lastTime ?? snapshot.stat.mtime.toISOString()
        };
      } catch {
        // Opening a corrupt session directly still reports the precise error;
        // listing healthy sessions remains available for recovery.
      }
    }
  });
  await Promise.all(workers);
  return summaries.filter((summary): summary is SessionSummary => summary !== undefined).sort((a, b) => a.fileName.localeCompare(b.fileName));
}

async function assertStandaloneSessionBinding(filePath: string, handle: FileHandle): Promise<void> {
  const descriptorStat = await handle.stat();
  const pathStat = await fs.lstat(filePath);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw new Error(`Session must be a single-link regular .jsonl file: ${filePath}`);
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function validateSessionEvent(value: unknown, lineNumber: number): SessionEvent {
  const parsed = sessionEventSchema.safeParse(value);
  if (parsed.success) return parsed.data as SessionEvent;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "event"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid session event at line ${String(lineNumber)}: ${detail}`);
}
