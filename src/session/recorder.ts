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
import { projectSessionsDir } from "../config/paths.js";
import type { SessionContextState, SessionContextUsage, SessionUsage } from "./metadata.js";
import type { AttachmentReference } from "../attachments/store.js";
import type { AgentMessage } from "../agent/core/types.js";

export type { SessionContextState, SessionContextUsage, SessionUsage, UsageOperation } from "./metadata.js";

/**
 * One provider reasoning block with the opaque metadata that makes it
 * replayable. Providers sign blocks individually, so concatenating several of
 * them under one signature produces history the provider will reject.
 */
export interface ReasoningBlock {
  text: string;
  providerOptions?: Record<string, unknown>;
}

export type SessionTurnStatus = "completed" | "incomplete" | "blocked" | "cancelled" | "failed" | "aborted";

/**
 * 一个公开 Agent 回合的稳定终态。
 *
 * Provider 消息和工具事件负责恢复模型上下文；这个事件只保存宿主需要恢复的完成语义，
 * 不参与模型消息重放。
 */
export interface SessionTurnStatusEvent {
  type: "turn_status";
  status: SessionTurnStatus;
  stopReason: string;
  steps: number;
  summary?: string;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  affectedTodoIds?: string[];
  time?: string;
}

export type SessionEvent =
  // session 事件类型要保持稳定；resume、未来上下文压缩和记忆功能都会依赖这几个基础类型。
  | { type: "user_message"; content: string; attachments?: AttachmentReference[]; skills?: string[]; contextUsage?: SessionContextUsage; contextState?: SessionContextState; preparationUsage?: SessionUsage[]; messageId?: string; parentMessageId?: string; auditOnly?: boolean; time?: string }
  | { type: "assistant_message"; content: string; reasoningContent?: string; reasoningProviderOptions?: Record<string, unknown>; reasoningBlocks?: ReasoningBlock[]; usage?: SessionUsage; relatedUsage?: SessionUsage[]; contextState?: SessionContextState; auditOnly?: boolean; time?: string }
  | { type: "tool_call"; tool: string; args: unknown; toolCallId?: string; sequence?: number; assistantContent?: string; reasoningContent?: string; reasoningProviderOptions?: Record<string, unknown>; reasoningBlocks?: ReasoningBlock[]; auditOnly?: boolean; time?: string }
  | { type: "tool_result"; tool: string; result: unknown; toolCallId?: string; sequence?: number; relatedUsage?: SessionUsage[]; auditOnly?: boolean; time?: string }
  | { type: "agent_message"; message: Exclude<AgentMessage, { role: "user" }>; messageId?: string; parentMessageId?: string; time?: string }
  | SessionTurnStatusEvent
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
  private lastMessageId: string | undefined;

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
    const safeEvent = redactSessionEvent(this.linkCanonicalMessage(event));
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

  restoreMessageParent(messageId: string | undefined): void {
    this.lastMessageId = messageId;
  }

  isUnrecordedDraft(): boolean {
    return !this.existedAtCreation && this.recordedEvents === 0;
  }

  repairTailForAppend(): void {
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    assertSessionFileSize(stat.size, this.filePath);
    if (stat.size === 0) return;
    let raw = readDescriptor(descriptor, stat.size);
    if (raw.at(-1) !== 0x0a) {
      const lastNewline = raw.lastIndexOf(0x0a);
      const tail = raw.subarray(lastNewline + 1).toString("utf8");
      try {
        JSON.parse(tail);
        writeSync(descriptor, "\n");
        raw = Buffer.concat([raw, Buffer.from("\n")]);
      } catch {
        ftruncateSync(descriptor, lastNewline + 1);
        raw = raw.subarray(0, lastNewline + 1);
      }
    }
    this.lastMessageId = lastPersistedMessageId(raw);
  }

  private linkCanonicalMessage(event: SessionEvent): SessionEvent {
    if (event.type !== "agent_message" && (event.type !== "user_message" || event.auditOnly)) return event;
    const messageId = event.messageId ?? createMessageId();
    const linked = { ...event, messageId, parentMessageId: event.parentMessageId ?? this.lastMessageId };
    this.lastMessageId = messageId;
    return linked;
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

/**
 * Redaction rewrites text, which invalidates the provider signature covering
 * it. A block whose text changed keeps its content but loses the metadata, so
 * replay omits it instead of resending history the provider will reject.
 */
function redactReasoningBlocks(blocks: ReasoningBlock[] | undefined): ReasoningBlock[] | undefined {
  return blocks?.map((block) => {
    const text = redactSecrets(block.text);
    if (text !== block.text || block.providerOptions === undefined) return { text };
    return { text, providerOptions: redactSensitiveValue(block.providerOptions) as Record<string, unknown> };
  });
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
      reasoningProviderOptions: event.reasoningProviderOptions === undefined ? undefined : redactSensitiveValue(event.reasoningProviderOptions) as Record<string, unknown>,
      reasoningBlocks: redactReasoningBlocks(event.reasoningBlocks),
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
      reasoningContent: event.reasoningContent === undefined ? undefined : redactSecrets(event.reasoningContent),
      reasoningProviderOptions: event.reasoningProviderOptions === undefined ? undefined : redactSensitiveValue(event.reasoningProviderOptions) as Record<string, unknown>,
      reasoningBlocks: redactReasoningBlocks(event.reasoningBlocks)
    };
  }
  if (event.type === "tool_result") {
    return { ...event, result: redactSensitiveValue(event.result) };
  }
  if (event.type === "agent_message") {
    return { ...event, message: redactAgentMessage(event.message) };
  }
  if (event.type === "turn_status") {
    return {
      ...event,
      summary: event.summary === undefined ? undefined : redactSecrets(event.summary),
      requiredAction: event.requiredAction === undefined ? undefined : redactSecrets(event.requiredAction),
      affectedTodoIds: event.affectedTodoIds?.map((todoId) => redactSecrets(todoId))
    };
  }
  return {
    ...event,
    message: redactSecrets(event.message),
    detail: event.detail === undefined ? undefined : redactSensitiveValue(event.detail)
  };
}

function redactAgentMessage(message: Exclude<AgentMessage, { role: "user" }>): Exclude<AgentMessage, { role: "user" }> {
  if (message.role === "toolResult") {
    return {
      ...message,
      content: message.content.map((part) => part.type === "text"
        ? { ...part, text: redactSecrets(part.text) }
        : { ...part, data: redactSecrets(part.data) }),
      details: message.details === undefined ? undefined : redactSensitiveValue(message.details)
    };
  }
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "text") return { ...part, text: redactSecrets(part.text) };
      if (part.type === "toolCall") {
        return { ...part, arguments: redactSensitiveValue(part.arguments) as Record<string, unknown> };
      }
      const text = redactSecrets(part.text);
      return {
        ...part,
        text,
        providerMetadata: text === part.text && part.providerMetadata !== undefined
          ? redactSensitiveValue(part.providerMetadata) as Record<string, unknown>
          : undefined
      };
    })
  };
}

function canonicalSessionFilePath(workspaceRoot: string, sessionId: string, requestedFilePath: string): string {
  const expectedName = path.basename(sessionFilePath(workspaceRoot, sessionId));
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = realpathSync(workspacePath);
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  const sessionsStat = lstatSync(sessionsPath);
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Project session storage must be a real directory, not a symbolic link.");
  }

  const canonicalSessions = realpathSync(sessionsPath);
  if (canonicalSessions !== sessionsPath) {
    throw new Error("Session storage resolves outside the current project's global session directory.");
  }
  if (realpathSync(path.dirname(requestedFilePath)) !== canonicalSessions || path.basename(requestedFilePath) !== expectedName) {
    throw new Error(`Session file resolves outside the current project's global session directory: ${expectedName}`);
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

function createMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function lastPersistedMessageId(raw: Buffer): string | undefined {
  const lines = raw.toString("utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; messageId?: unknown; auditOnly?: unknown };
      if (
        typeof event.messageId === "string"
        && (event.type === "agent_message" || (event.type === "user_message" && event.auditOnly !== true))
      ) return event.messageId;
    } catch {
      // JSONL 中间损坏由严格解析负责报错；这里仅尽力恢复追加节点的父链。
    }
  }
  return undefined;
}

export function createSessionId(): string {
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
