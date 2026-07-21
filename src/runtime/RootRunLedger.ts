/**
 * Durable lifecycle records for interactive root runs.
 *
 * Session JSONL intentionally keeps its small stable event vocabulary. Root
 * scheduling state therefore lives next to it in `.agent/runs`, where it can
 * be recovered without pretending an interrupted model stream can resume.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import path from "node:path";
import type { AgentRunMode } from "../agent/AgentSession.js";
import type { SessionUsage } from "../session/metadata.js";
import { ensureAgentDirs } from "../session/store.js";
import { redactSecrets } from "../utils/secrets.js";

const ledgerVersion = 1;
const maxRecordBytes = 256 * 1024;
const maxLeaseBytes = 16 * 1024;
const maxMessageChars = 4_000;
const maxRunRecords = 10_000;
const runFilePrefix = "root-run-";
const runFileSuffix = ".json";
const leaseFileName = "interactive-runtime.lock";

export type RootRunLedgerStatus = "queued" | "running" | "completed" | "incomplete" | "failed" | "aborted";

export interface RootRunLedgerTransition {
  status: RootRunLedgerStatus;
  at: string;
  reason?: string;
}

export interface RootRunLedgerSnapshot {
  version: typeof ledgerVersion;
  runId: string;
  sessionId: string;
  messageId: string;
  mode: AgentRunMode;
  inputDigest: string;
  ownerRuntimeId: string;
  status: RootRunLedgerStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  usage?: SessionUsage;
  error?: string;
  recovered?: boolean;
  transitions: RootRunLedgerTransition[];
}

export interface RootRunLedgerAdmission {
  runId: string;
  sessionId: string;
  messageId: string;
  mode: AgentRunMode;
  input: string;
  queuedAt: string;
}

export interface RootRunLedgerTerminalDetails {
  endedAt: string;
  durationMs: number;
  usage?: SessionUsage;
  reason?: string;
}

interface FileIdentity {
  device: number;
  inode: number;
}

interface RuntimeLease {
  version: typeof ledgerVersion;
  runtimeId: string;
  pid: number;
  createdAt: string;
}

/** Raised when a state transition would overwrite a completed lifecycle. */
export class RootRunLedgerTerminalStateError extends Error {
  constructor(runId: string, status: RootRunLedgerStatus) {
    super(`Root run ${runId} is already terminal (${status}).`);
    this.name = "RootRunLedgerTerminalStateError";
  }
}

/** Raised when another live interactive runtime owns the same persistence root. */
export class RootRunLedgerLeaseError extends Error {
  constructor(pid: number) {
    super(`Interactive runtime ledger is already owned by process ${String(pid)}.`);
    this.name = "RootRunLedgerLeaseError";
  }
}

/**
 * A synchronous ledger is deliberate: every lifecycle transition is committed
 * before the corresponding host event is emitted, so there is no window where
 * a visible terminal event has no durable counterpart.
 */
export class RootRunLedger {
  readonly runtimeId: string;
  readonly directoryPath: string;
  private readonly directoryIdentity: FileIdentity;
  private readonly leasePath: string;
  private leaseIdentity: FileIdentity | undefined;
  private closed = false;

  private constructor(
    readonly persistenceRoot: string,
    directoryPath: string,
    directoryIdentity: FileIdentity,
    runtimeId: string
  ) {
    this.directoryPath = directoryPath;
    this.directoryIdentity = directoryIdentity;
    this.runtimeId = runtimeId;
    this.leasePath = path.join(directoryPath, leaseFileName);
  }

  static async open(persistenceRoot: string): Promise<RootRunLedger> {
    await ensureAgentDirs(persistenceRoot);
    const canonicalRoot = realpathSync(path.resolve(persistenceRoot));
    const rootStat = lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Root run persistence root must be a real directory.");
    }
    const agentPath = path.join(canonicalRoot, ".agent");
    const runsPath = path.join(agentPath, "runs");
    const canonicalRuns = realpathSync(runsPath);
    if (canonicalRuns !== runsPath) {
      throw new Error("Root run storage .agent/runs resolves outside the canonical persistence root.");
    }
    const runsStat = lstatSync(canonicalRuns);
    if (runsStat.isSymbolicLink() || !runsStat.isDirectory()) {
      throw new Error("Root run storage .agent/runs must be a real directory, not a symbolic link.");
    }
    const ledger = new RootRunLedger(
      canonicalRoot,
      canonicalRuns,
      fileIdentity(runsStat),
      randomUUID()
    );
    try {
      ledger.acquireLease();
      ledger.recoverInterruptedRuns();
      return ledger;
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  admit(admission: RootRunLedgerAdmission): RootRunLedgerSnapshot {
    this.assertOpen();
    assertRunId(admission.runId);
    assertNonEmptyValue(admission.sessionId, "session id");
    assertNonEmptyValue(admission.messageId, "message id");
    assertTimestamp(admission.queuedAt, "queuedAt");
    const recordPath = this.recordPath(admission.runId);
    if (this.existingFileIdentity(recordPath)) {
      throw new Error(`Root run ledger already contains ${admission.runId}.`);
    }
    const record: RootRunLedgerSnapshot = {
      version: ledgerVersion,
      runId: admission.runId,
      sessionId: admission.sessionId,
      messageId: admission.messageId,
      mode: admission.mode,
      inputDigest: digestInput(admission.input),
      ownerRuntimeId: this.runtimeId,
      status: "queued",
      createdAt: admission.queuedAt,
      startedAt: undefined,
      endedAt: undefined,
      durationMs: undefined,
      usage: undefined,
      error: undefined,
      recovered: undefined,
      transitions: [{ status: "queued", at: admission.queuedAt, reason: undefined }]
    };
    this.writeRecord(record, "create");
    return cloneSnapshot(record);
  }

  start(runId: string, startedAt: string): RootRunLedgerSnapshot {
    return this.transition(runId, "running", {
      at: startedAt,
      durationMs: undefined,
      usage: undefined,
      reason: undefined,
      recovered: undefined
    });
  }

  complete(runId: string, details: RootRunLedgerTerminalDetails): RootRunLedgerSnapshot {
    return this.transition(runId, "completed", {
      at: details.endedAt,
      durationMs: details.durationMs,
      usage: details.usage,
      reason: undefined,
      recovered: undefined
    });
  }

  incomplete(runId: string, details: RootRunLedgerTerminalDetails): RootRunLedgerSnapshot {
    return this.transition(runId, "incomplete", {
      at: details.endedAt,
      durationMs: details.durationMs,
      usage: details.usage,
      reason: details.reason,
      recovered: undefined
    });
  }

  fail(runId: string, details: RootRunLedgerTerminalDetails): RootRunLedgerSnapshot {
    return this.transition(runId, "failed", {
      at: details.endedAt,
      durationMs: details.durationMs,
      usage: details.usage,
      reason: details.reason,
      recovered: undefined
    });
  }

  abort(runId: string, details: RootRunLedgerTerminalDetails, recovered = false): RootRunLedgerSnapshot {
    return this.transition(runId, "aborted", {
      at: details.endedAt,
      durationMs: details.durationMs,
      usage: details.usage,
      reason: details.reason,
      recovered
    });
  }

  getSnapshot(runId: string): RootRunLedgerSnapshot {
    this.assertOpen();
    assertRunId(runId);
    return cloneSnapshot(this.readRecord(runId));
  }

  listSnapshots(): RootRunLedgerSnapshot[] {
    this.assertOpen();
    this.assertDirectoryBinding();
    const recordFileNames = readdirSync(this.directoryPath).filter((fileName) => isRunRecordFileName(fileName));
    if (recordFileNames.length > maxRunRecords) {
      throw new Error(`Root run ledger has more than ${String(maxRunRecords)} records; archive old .agent/runs entries before opening the runtime.`);
    }
    const records = recordFileNames.map((fileName) => this.readRecord(fileName.slice(runFilePrefix.length, -runFileSuffix.length)));
    records.sort((left, right) => latestLifecycleTime(right).localeCompare(latestLifecycleTime(left)) || right.runId.localeCompare(left.runId));
    return records.map(cloneSnapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const leaseIdentity = this.leaseIdentity;
    this.leaseIdentity = undefined;
    if (!leaseIdentity) return;
    try {
      this.assertDirectoryBinding();
      const currentIdentity = this.existingFileIdentity(this.leasePath);
      if (!currentIdentity || !sameIdentity(currentIdentity, leaseIdentity)) return;
      const lease = this.readLease();
      if (lease.runtimeId !== this.runtimeId) return;
      unlinkSync(this.leasePath);
    } catch {
      // Never unlink an unexpected replacement lock. A stale lock is safe and
      // will be reclaimed only after its owner pid is no longer alive.
    }
  }

  private transition(
    runId: string,
    nextStatus: RootRunLedgerStatus,
    details: {
      at: string;
      durationMs: number | undefined;
      usage: SessionUsage | undefined;
      reason: string | undefined;
      recovered: boolean | undefined;
    }
  ): RootRunLedgerSnapshot {
    this.assertOpen();
    assertRunId(runId);
    assertTimestamp(details.at, "transition timestamp");
    if (details.durationMs !== undefined) assertDuration(details.durationMs);
    const record = this.readRecord(runId);
    if (isTerminal(record.status)) throw new RootRunLedgerTerminalStateError(runId, record.status);
    if (nextStatus === "running" && record.status !== "queued") {
      throw new Error(`Root run ${runId} cannot start from ${record.status}.`);
    }
    if (isTerminal(nextStatus) && record.status !== "queued" && record.status !== "running") {
      throw new Error(`Root run ${runId} cannot finish from ${record.status}.`);
    }
    const publicReason = details.reason === undefined ? undefined : publicMessage(details.reason);
    const updated: RootRunLedgerSnapshot = {
      ...record,
      status: nextStatus,
      startedAt: nextStatus === "running" ? details.at : record.startedAt,
      endedAt: isTerminal(nextStatus) ? details.at : undefined,
      durationMs: isTerminal(nextStatus) ? details.durationMs : undefined,
      usage: isTerminal(nextStatus) ? sanitizeUsage(details.usage) : undefined,
      error: nextStatus === "failed" ? publicReason : undefined,
      recovered: isTerminal(nextStatus) ? details.recovered : undefined,
      transitions: [...record.transitions, { status: nextStatus, at: details.at, reason: publicReason }]
    };
    this.writeRecord(updated, "replace");
    return cloneSnapshot(updated);
  }

  private recoverInterruptedRuns(): void {
    for (const record of this.listSnapshots()) {
      if (isTerminal(record.status)) continue;
      const endedAt = new Date().toISOString();
      this.abort(record.runId, {
        endedAt,
        durationMs: durationSince(record.startedAt ?? record.createdAt, endedAt),
        usage: undefined,
        reason: "Recovered after the previous interactive runtime ended before a terminal state."
      }, true);
    }
  }

  private acquireLease(): void {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        this.leaseIdentity = this.writeNewLease();
        return;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        const existingLease = this.readLease();
        if (isProcessAlive(existingLease.pid)) throw new RootRunLedgerLeaseError(existingLease.pid);
        this.retireStaleLease();
      }
    }
    throw new Error("Could not acquire the interactive runtime ledger lease after repeated lock races.");
  }

  private writeNewLease(): FileIdentity {
    this.assertDirectoryBinding();
    const content = Buffer.from(JSON.stringify({
      version: ledgerVersion,
      runtimeId: this.runtimeId,
      pid: process.pid,
      createdAt: new Date().toISOString()
    } satisfies RuntimeLease));
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.leasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600);
      writeAll(descriptor, content);
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      assertSafeRegularFile(stat, leaseFileName, maxLeaseBytes);
      const identity = fileIdentity(stat);
      const pathIdentity = this.fileIdentityAtPath(this.leasePath);
      if (!sameIdentity(identity, pathIdentity)) throw new Error("Interactive runtime lease changed during creation.");
      return identity;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private retireStaleLease(): void {
    const identity = this.fileIdentityAtPath(this.leasePath);
    const stalePath = path.join(this.directoryPath, `.interactive-runtime-stale-${Date.now()}-${randomBytes(8).toString("hex")}.json`);
    renameSync(this.leasePath, stalePath);
    const movedIdentity = this.fileIdentityAtPath(stalePath);
    if (!sameIdentity(identity, movedIdentity)) {
      throw new Error("Interactive runtime lease changed while reclaiming a stale lock.");
    }
  }

  private readLease(): RuntimeLease {
    const value = parseJson(this.readSecureFile(this.leasePath, maxLeaseBytes), "interactive runtime lease");
    if (!isRecord(value)) throw new Error("Interactive runtime lease is malformed.");
    const version = value.version;
    const runtimeId = value.runtimeId;
    const pid = value.pid;
    const createdAt = value.createdAt;
    if (version !== ledgerVersion || typeof runtimeId !== "string" || !runtimeId || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof createdAt !== "string") {
      throw new Error("Interactive runtime lease is malformed.");
    }
    assertTimestamp(createdAt, "lease createdAt");
    return { version: ledgerVersion, runtimeId, pid, createdAt };
  }

  private readRecord(runId: string): RootRunLedgerSnapshot {
    const recordPath = this.recordPath(runId);
    const value = parseJson(this.readSecureFile(recordPath, maxRecordBytes), `root run ${runId}`);
    return parseSnapshot(value, runId);
  }

  private writeRecord(record: RootRunLedgerSnapshot, operation: "create" | "replace"): void {
    this.assertDirectoryBinding();
    const recordPath = this.recordPath(record.runId);
    const previousIdentity = this.existingFileIdentity(recordPath);
    if (operation === "create" && previousIdentity) {
      throw new Error(`Root run ledger already contains ${record.runId}.`);
    }
    if (operation === "replace" && !previousIdentity) {
      throw new Error(`Root run ${record.runId} disappeared before its lifecycle transition could persist.`);
    }
    const tempPath = path.join(this.directoryPath, `.${runFilePrefix}${record.runId}.${randomBytes(8).toString("hex")}.tmp`);
    const content = Buffer.from(JSON.stringify(record));
    if (content.byteLength > maxRecordBytes) {
      throw new Error(`Root run ${record.runId} ledger record exceeds ${String(maxRecordBytes)} bytes.`);
    }
    let descriptor: number | undefined;
    let tempIdentity: FileIdentity | undefined;
    let createdTemp = false;
    let replaced = false;
    try {
      descriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      createdTemp = true;
      fchmodSync(descriptor, 0o600);
      writeAll(descriptor, content);
      fsyncSync(descriptor);
      const tempStat = fstatSync(descriptor);
      assertSafeRegularFile(tempStat, path.basename(tempPath), maxRecordBytes);
      tempIdentity = fileIdentity(tempStat);
      closeSync(descriptor);
      descriptor = undefined;

      this.assertDirectoryBinding();
      if (previousIdentity) {
        const currentIdentity = this.fileIdentityAtPath(recordPath);
        if (!sameIdentity(currentIdentity, previousIdentity)) {
          throw new Error(`Root run ${record.runId} changed during ledger replacement.`);
        }
      } else if (this.existingFileIdentity(recordPath)) {
        throw new Error(`Root run ${record.runId} appeared during ledger creation.`);
      }
      renameSync(tempPath, recordPath);
      const writtenIdentity = this.fileIdentityAtPath(recordPath);
      if (!sameIdentity(writtenIdentity, tempIdentity)) {
        throw new Error(`Root run ${record.runId} changed during ledger replacement.`);
      }
      replaced = true;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (!replaced && createdTemp && !tempIdentity) tempIdentity = this.existingFileIdentity(tempPath);
      if (!replaced && createdTemp && tempIdentity) this.removeBoundFile(tempPath, tempIdentity);
    }
  }

  private removeBoundFile(filePath: string, identity: FileIdentity): void {
    try {
      const currentIdentity = this.fileIdentityAtPath(filePath);
      if (sameIdentity(currentIdentity, identity)) unlinkSync(filePath);
    } catch {
      // The failed temporary write is best-effort cleanup only. Never unlink a
      // replacement that did not originate from this ledger instance.
    }
  }

  private recordPath(runId: string): string {
    assertRunId(runId);
    return path.join(this.directoryPath, `${runFilePrefix}${runId}${runFileSuffix}`);
  }

  private readSecureFile(filePath: string, maxBytes: number): Buffer {
    this.assertDirectoryBinding();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      assertSafeRegularFile(stat, path.basename(filePath), maxBytes);
      const beforeIdentity = this.fileIdentityAtPath(filePath);
      if (!sameIdentity(fileIdentity(stat), beforeIdentity)) {
        throw new Error(`${path.basename(filePath)} changed during ledger read.`);
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) throw new Error(`${path.basename(filePath)} ended during ledger read.`);
        offset += read;
      }
      const afterStat = fstatSync(descriptor);
      const afterIdentity = this.fileIdentityAtPath(filePath);
      if (!sameIdentity(fileIdentity(afterStat), beforeIdentity) || !sameIdentity(afterIdentity, beforeIdentity)) {
        throw new Error(`${path.basename(filePath)} changed during ledger read.`);
      }
      return bytes;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private existingFileIdentity(filePath: string): FileIdentity | undefined {
    try {
      return this.fileIdentityAtPath(filePath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private fileIdentityAtPath(filePath: string): FileIdentity {
    this.assertDirectoryBinding();
    const stat = lstatSync(filePath);
    assertSafeRegularFile(stat, path.basename(filePath), maxRecordBytes);
    return fileIdentity(stat);
  }

  private assertDirectoryBinding(): void {
    const stat = lstatSync(this.directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(fileIdentity(stat), this.directoryIdentity)) {
      throw new Error("Root run storage directory changed during runtime.");
    }
    if (realpathSync(this.directoryPath) !== this.directoryPath) {
      throw new Error("Root run storage directory resolves outside the canonical persistence root.");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Root run ledger is closed.");
  }
}

function parseSnapshot(value: unknown, expectedRunId: string): RootRunLedgerSnapshot {
  if (!isRecord(value)) throw new Error(`Root run ${expectedRunId} ledger record is malformed.`);
  const version = value.version;
  const runId = value.runId;
  const sessionId = value.sessionId;
  const messageId = value.messageId;
  const mode = value.mode;
  const inputDigest = value.inputDigest;
  const ownerRuntimeId = value.ownerRuntimeId;
  const status = value.status;
  const createdAt = value.createdAt;
  const transitions = value.transitions;
  if (
    version !== ledgerVersion
    || runId !== expectedRunId
    || typeof sessionId !== "string"
    || typeof messageId !== "string"
    || (mode !== "chat" && mode !== "plan")
    || typeof inputDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(inputDigest)
    || typeof ownerRuntimeId !== "string"
    || !isLedgerStatus(status)
    || typeof createdAt !== "string"
    || !Array.isArray(transitions)
  ) {
    throw new Error(`Root run ${expectedRunId} ledger record is malformed.`);
  }
  assertNonEmptyValue(sessionId, "session id");
  assertNonEmptyValue(messageId, "message id");
  assertNonEmptyValue(ownerRuntimeId, "runtime id");
  assertTimestamp(createdAt, "createdAt");
  const parsedTransitions = transitions.map((transition) => parseTransition(transition, expectedRunId));
  if (!parsedTransitions.length || parsedTransitions[0]?.status !== "queued" || parsedTransitions.at(-1)?.status !== status) {
    throw new Error(`Root run ${expectedRunId} ledger transitions are malformed.`);
  }
  const startedAt = optionalTimestamp(value.startedAt, "startedAt");
  const endedAt = optionalTimestamp(value.endedAt, "endedAt");
  const durationMs = optionalDuration(value.durationMs);
  const usage = optionalUsage(value.usage);
  const error = optionalPublicMessage(value.error);
  const recovered = optionalBoolean(value.recovered);
  if (status === "running" && !startedAt) throw new Error(`Root run ${expectedRunId} is running without startedAt.`);
  if (isTerminal(status) && (!endedAt || durationMs === undefined)) {
    throw new Error(`Root run ${expectedRunId} is terminal without completion metadata.`);
  }
  if (!isTerminal(status) && (endedAt || durationMs !== undefined || usage || error || recovered !== undefined)) {
    throw new Error(`Root run ${expectedRunId} has terminal metadata before completion.`);
  }
  if (status === "failed" && !error) throw new Error(`Root run ${expectedRunId} failed without an error.`);
  return {
    version: ledgerVersion,
    runId,
    sessionId,
    messageId,
    mode,
    inputDigest,
    ownerRuntimeId,
    status,
    createdAt,
    startedAt,
    endedAt,
    durationMs,
    usage,
    error,
    recovered,
    transitions: parsedTransitions
  };
}

function parseTransition(value: unknown, runId: string): RootRunLedgerTransition {
  if (!isRecord(value) || !isLedgerStatus(value.status) || typeof value.at !== "string") {
    throw new Error(`Root run ${runId} ledger transition is malformed.`);
  }
  assertTimestamp(value.at, "transition timestamp");
  const reason = optionalPublicMessage(value.reason);
  return { status: value.status, at: value.at, reason };
}

function optionalUsage(value: unknown): SessionUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Root run usage is malformed.");
  const operation = value.operation;
  const modelAlias = value.modelAlias;
  const provider = value.provider;
  const model = value.model;
  const pricingKnown = value.pricingKnown;
  if (
    (operation !== "agent" && operation !== "plan" && operation !== "compaction" && operation !== "memory" && operation !== "subagent")
    || typeof modelAlias !== "string"
    || typeof provider !== "string"
    || typeof model !== "string"
    || typeof pricingKnown !== "boolean"
  ) {
    throw new Error("Root run usage is malformed.");
  }
  return {
    operation,
    modelAlias: redactSecrets(modelAlias),
    provider: redactSecrets(provider),
    model: redactSecrets(model),
    inputTokens: optionalUsageNumber(value.inputTokens),
    outputTokens: optionalUsageNumber(value.outputTokens),
    totalTokens: optionalUsageNumber(value.totalTokens),
    reasoningTokens: optionalUsageNumber(value.reasoningTokens),
    cacheReadTokens: optionalUsageNumber(value.cacheReadTokens),
    cacheWriteTokens: optionalUsageNumber(value.cacheWriteTokens),
    costUsd: optionalUsageNumber(value.costUsd),
    pricingKnown,
    time: typeof value.time === "string" ? redactSecrets(value.time) : undefined
  };
}

function optionalUsageNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Root run usage contains an invalid number.");
  }
  return value;
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Root run ${name} is malformed.`);
  assertTimestamp(value, name);
  return value;
}

function optionalDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("Root run duration is malformed.");
  assertDuration(value);
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Root run boolean field is malformed.");
  return value;
}

function optionalPublicMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Root run message is malformed.");
  const message = publicMessage(value);
  if (message !== value) throw new Error("Root run message is not safely redacted.");
  return message;
}

function sanitizeUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  if (!usage) return undefined;
  return {
    operation: usage.operation,
    modelAlias: redactSecrets(usage.modelAlias),
    provider: redactSecrets(usage.provider),
    model: redactSecrets(usage.model),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    pricingKnown: usage.pricingKnown,
    time: usage.time === undefined ? undefined : redactSecrets(usage.time)
  };
}

function cloneSnapshot(record: RootRunLedgerSnapshot): RootRunLedgerSnapshot {
  return {
    ...record,
    usage: record.usage === undefined ? undefined : { ...record.usage },
    transitions: record.transitions.map((transition) => ({ ...transition }))
  };
}

function digestInput(input: string): string {
  return `sha256:${createHash("sha256").update(redactSecrets(input)).digest("hex")}`;
}

function publicMessage(value: string): string {
  const redacted = redactSecrets(value).trim();
  if (!redacted) return "Unknown root run failure.";
  return redacted.length <= maxMessageChars ? redacted : `${redacted.slice(0, maxMessageChars - 1)}…`;
}

function durationSince(startedAt: string, endedAt: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : 0;
}

function latestLifecycleTime(record: RootRunLedgerSnapshot): string {
  return record.endedAt ?? record.startedAt ?? record.createdAt;
}

function isRunRecordFileName(value: string): boolean {
  return value.startsWith(runFilePrefix)
    && value.endsWith(runFileSuffix)
    && /^[A-Za-z0-9_-]{1,128}$/u.test(value.slice(runFilePrefix.length, -runFileSuffix.length));
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId)) throw new Error(`Invalid root run id: ${runId}`);
}

function assertNonEmptyValue(value: string, name: string): void {
  if (!value || value.length > 512 || value.includes("\0")) throw new Error(`Invalid root run ${name}.`);
}

function assertTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid root run ${name}.`);
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Root run duration must be a non-negative safe integer.");
}

function assertSafeRegularFile(stat: Stats, name: string, maxBytes: number): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error(`Root run ledger file is unsafe: ${name}`);
  }
}

function fileIdentity(stat: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isTerminal(status: RootRunLedgerStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "aborted";
}

function isLedgerStatus(value: unknown): value is RootRunLedgerStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "incomplete" || value === "failed" || value === "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Buffer, description: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new Error("Could not write root run ledger data.");
    offset += written;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
