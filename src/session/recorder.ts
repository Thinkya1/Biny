/**
 * Session 记录模块。
 *
 * 每一轮交互中的用户消息、assistant 回复、工具调用、工具结果和错误都会通过这个 recorder
 * 追加成 JSONL。追加写入让长会话可以持续落盘，也方便后续 resume、压缩和记忆功能按行读取。
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { sessionFilePath } from "./store.js";
import type { SessionContextState, SessionContextUsage, SessionUsage } from "./metadata.js";

export type { SessionContextState, SessionContextUsage, SessionUsage, UsageOperation } from "./metadata.js";

export type SessionEvent =
  // session 事件类型要保持稳定；resume、未来上下文压缩和记忆功能都会依赖这几个基础类型。
  | { type: "user_message"; content: string; contextUsage?: SessionContextUsage; contextState?: SessionContextState; preparationUsage?: SessionUsage[]; time?: string }
  | { type: "assistant_message"; content: string; reasoningContent?: string; usage?: SessionUsage; contextState?: SessionContextState; time?: string }
  | { type: "tool_call"; tool: string; args: unknown; toolCallId?: string; sequence?: number; assistantContent?: string; reasoningContent?: string; time?: string }
  | { type: "tool_result"; tool: string; result: unknown; toolCallId?: string; sequence?: number; time?: string }
  | { type: "error"; message: string; detail?: unknown; time?: string };

export class SessionRecorder {
  readonly sessionId: string;
  readonly filePath: string;
  private stream?: WriteStream;
  private closePromise?: Promise<void>;
  private toolCallSequence = 0;
  private recordedEvents = 0;

  constructor(workspaceRoot: string, sessionId = createSessionId()) {
    // sessionId 默认按时间和随机后缀生成，便于人工排序也避免同秒冲突。
    this.sessionId = sessionId;
    this.filePath = sessionFilePath(workspaceRoot, this.sessionId);
  }

  record(event: SessionEvent): void {
    // 每个事件一行 JSON，便于追加写入，也方便后续按行读取和压缩。
    const line = JSON.stringify({ ...event, time: event.time ?? new Date().toISOString() });
    this.stream ??= createWriteStream(this.filePath, { flags: "a" });
    this.stream.write(`${line}\n`);
    this.recordedEvents += 1;
  }

  nextToolCallSequence(): number {
    this.toolCallSequence += 1;
    return this.toolCallSequence;
  }

  restoreToolCallSequence(sequence: number): void {
    this.toolCallSequence = Math.max(this.toolCallSequence, sequence);
  }

  hasRecordedEvents(): boolean {
    return this.recordedEvents > 0;
  }

  close(): Promise<void> {
    // close 可能被 finally 和外部清理重复调用，用同一个 promise 保证只 end 一次。
    if (!this.stream) return Promise.resolve();
    this.closePromise ??= new Promise((resolve, reject) => {
      this.stream?.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return this.closePromise;
  }
}

function createSessionId(): string {
  // 文件名中避免使用冒号，兼容不同平台的路径规则。
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}
