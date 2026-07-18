/**
 * Session 记录模块。
 *
 * 每一轮交互中的用户消息、assistant 回复、工具调用、工具结果和错误都会通过这个 recorder
 * 追加成 JSONL。追加写入让长会话可以持续落盘，也方便后续 resume、压缩和记忆功能按行读取。
 */
import {
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
  type WriteStream
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import { assertSessionFileSize } from "./limits.js";
import { sessionFilePath } from "./store.js";
import type { SessionContextState, SessionContextUsage, SessionUsage } from "./metadata.js";

export type { SessionContextState, SessionContextUsage, SessionUsage, UsageOperation } from "./metadata.js";

export type SessionEvent =
  // session 事件类型要保持稳定；resume、未来上下文压缩和记忆功能都会依赖这几个基础类型。
  | { type: "user_message"; content: string; skills?: string[]; contextUsage?: SessionContextUsage; contextState?: SessionContextState; preparationUsage?: SessionUsage[]; auditOnly?: boolean; time?: string }
  | { type: "assistant_message"; content: string; reasoningContent?: string; usage?: SessionUsage; relatedUsage?: SessionUsage[]; contextState?: SessionContextState; auditOnly?: boolean; time?: string }
  | { type: "tool_call"; tool: string; args: unknown; toolCallId?: string; sequence?: number; assistantContent?: string; reasoningContent?: string; auditOnly?: boolean; time?: string }
  | { type: "tool_result"; tool: string; result: unknown; toolCallId?: string; sequence?: number; relatedUsage?: SessionUsage[]; auditOnly?: boolean; time?: string }
  | { type: "error"; message: string; detail?: unknown; relatedUsage?: SessionUsage[]; time?: string };

export class SessionRecorder {
  readonly sessionId: string;
  readonly filePath: string;
  private stream?: WriteStream;
  private descriptor?: number;
  private readonly descriptorIdentity: Pick<Stats, "dev" | "ino">;
  private closePromise?: Promise<void>;
  private streamError: Error | undefined;
  private closed = false;
  private toolCallSequence = 0;
  private recordedEvents = 0;
  private readonly existedAtCreation: boolean;

  constructor(workspaceRoot: string, sessionId = createSessionId(), resolvedFilePath = sessionFilePath(workspaceRoot, sessionId)) {
    // sessionId 默认按时间和随机后缀生成，便于人工排序也避免同秒冲突。
    this.sessionId = sessionId;
    this.filePath = canonicalSessionFilePath(workspaceRoot, sessionId, resolvedFilePath);
    this.existedAtCreation = existsSync(this.filePath);
    const descriptor = openSync(this.filePath, sessionOpenFlags(), 0o600);
    try {
      if (canonicalSessionFilePath(workspaceRoot, sessionId, resolvedFilePath) !== this.filePath) {
        throw new Error(`Session storage changed while opening ${this.sessionId}.`);
      }
      const stat = validateSessionDescriptor(descriptor, this.filePath);
      fchmodSync(descriptor, 0o600);
      this.descriptor = descriptor;
      this.descriptorIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  record(event: SessionEvent): void {
    // 每个事件一行 JSON，便于追加写入，也方便后续按行读取和压缩。
    if (this.closed) throw new Error(`Session recorder is already closed: ${this.sessionId}`);
    const safeEvent = redactSessionEvent(event);
    const line = JSON.stringify({ ...safeEvent, time: event.time ?? new Date().toISOString() });
    if (!this.stream) {
      const descriptor = this.descriptor;
      if (descriptor === undefined) throw new Error(`Session recorder has no open descriptor: ${this.sessionId}`);
      validateSessionDescriptor(descriptor, this.filePath);
      try {
        this.stream = createWriteStream(this.filePath, { fd: descriptor, autoClose: true });
        this.descriptor = undefined;
      } catch (error) {
        closeSync(descriptor);
        this.descriptor = undefined;
        throw error;
      }
      this.stream.on("error", (error) => {
        this.streamError ??= error;
      });
    }
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

  isUnrecordedDraft(): boolean {
    return !this.existedAtCreation && this.recordedEvents === 0;
  }

  repairTailForAppend(): void {
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    assertSessionFileSize(stat.size, this.filePath);
    if (stat.size === 0) return;
    const raw = readDescriptor(descriptor, stat.size);
    if (raw.at(-1) === 0x0a) return;
    const lastNewline = raw.lastIndexOf(0x0a);
    const tail = raw.subarray(lastNewline + 1).toString("utf8");
    try {
      JSON.parse(tail);
      writeSync(descriptor, "\n");
    } catch {
      ftruncateSync(descriptor, lastNewline + 1);
    }
  }

  readText(): string {
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    assertSessionFileSize(stat.size, this.filePath);
    return readDescriptor(descriptor, stat.size).toString("utf8");
  }

  close(): Promise<void> {
    // close 可能被 finally 和外部清理重复调用，用同一个 promise 保证只 end 一次。
    this.closed = true;
    if (!this.stream) {
      if (this.descriptor !== undefined) {
        closeSync(this.descriptor);
        this.descriptor = undefined;
      }
      if (this.isUnrecordedDraft()) removeDraftFile(this.filePath, this.descriptorIdentity);
      return this.streamError ? Promise.reject(this.streamError) : Promise.resolve();
    }
    this.closePromise ??= new Promise((resolve, reject) => {
      const stream = this.stream;
      if (!stream) return resolve();
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (this.streamError) reject(this.streamError);
        else resolve();
      };
      if (stream.closed) return settle();
      stream.once("finish", settle);
      stream.once("close", settle);
      stream.end();
    });
    return this.closePromise;
  }

  private openDescriptor(): number {
    if (this.closed || this.stream || this.descriptor === undefined) {
      throw new Error(`Session recorder is not available for direct file access: ${this.sessionId}`);
    }
    return this.descriptor;
  }
}

function redactSessionEvent(event: SessionEvent): SessionEvent {
  if (event.type === "user_message") {
    return {
      ...event,
      content: redactSecrets(event.content),
      contextState: event.contextState === undefined
        ? undefined
        : redactSensitiveValue(event.contextState) as SessionContextState
    };
  }
  if (event.type === "assistant_message") {
    return {
      ...event,
      content: redactSecrets(event.content),
      reasoningContent: event.reasoningContent === undefined ? undefined : redactSecrets(event.reasoningContent),
      contextState: event.contextState === undefined
        ? undefined
        : redactSensitiveValue(event.contextState) as SessionContextState
    };
  }
  if (event.type === "tool_call") {
    return {
      ...event,
      args: redactSensitiveValue(event.args),
      assistantContent: event.assistantContent === undefined ? undefined : redactSecrets(event.assistantContent),
      reasoningContent: event.reasoningContent === undefined ? undefined : redactSecrets(event.reasoningContent)
    };
  }
  if (event.type === "tool_result") {
    return { ...event, result: redactSensitiveValue(event.result) };
  }
  return {
    ...event,
    message: redactSecrets(event.message),
    detail: event.detail === undefined ? undefined : redactSensitiveValue(event.detail)
  };
}

function canonicalSessionFilePath(workspaceRoot: string, sessionId: string, requestedFilePath: string): string {
  const expectedName = path.basename(sessionFilePath(workspaceRoot, sessionId));
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = realpathSync(workspacePath);
  const agentPath = path.join(canonicalWorkspace, ".agent");
  const sessionsPath = path.join(agentPath, "sessions");
  const agentStat = lstatSync(agentPath);
  const sessionsStat = lstatSync(sessionsPath);
  if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) {
    throw new Error("Session storage .agent must be a real directory, not a symbolic link.");
  }
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Session storage .agent/sessions must be a real directory, not a symbolic link.");
  }

  const canonicalSessions = realpathSync(sessionsPath);
  if (canonicalSessions !== path.join(canonicalWorkspace, ".agent", "sessions")) {
    throw new Error("Session storage resolves outside the canonical .agent/sessions directory.");
  }
  if (realpathSync(path.dirname(requestedFilePath)) !== canonicalSessions || path.basename(requestedFilePath) !== expectedName) {
    throw new Error(`Session file resolves outside the canonical .agent/sessions directory: ${expectedName}`);
  }

  const canonicalFile = path.join(canonicalSessions, expectedName);
  if (existsSync(canonicalFile)) {
    const stat = lstatSync(canonicalFile);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Session must be a single-link regular .jsonl file, not a symbolic link, hardlink, or directory: ${expectedName}`);
    }
  }
  return canonicalFile;
}

function sessionOpenFlags(): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | noFollow;
}

function validateSessionDescriptor(descriptor: number, filePath: string): Stats {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Session must be a single-link regular .jsonl file: ${path.basename(filePath)}`);
  }
  const pathStat = lstatSync(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1 || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
    throw new Error(`Session file changed while it was being opened: ${path.basename(filePath)}`);
  }
  return stat;
}

function readDescriptor(descriptor: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(descriptor, buffer, offset, size - offset, offset);
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  return buffer;
}

function removeDraftFile(filePath: string, identity: Pick<Stats, "dev" | "ino">): void {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino) {
      unlinkSync(filePath);
    }
  } catch {
    // A missing or replaced draft must never cause cleanup to touch another file.
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
