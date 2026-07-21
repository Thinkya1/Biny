import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { SessionUsage } from "../session/metadata.js";
import { ensureAgentDirs } from "../session/store.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import type { TaskAttemptBudget } from "./TaskAttemptLoop.js";
import type { AcceptanceEvidence, TaskRequest, TaskToolEvidence } from "./types.js";

const taskRunVersion = 1;
const taskFilePrefix = "task-run-";
const taskFileSuffix = ".json";
const maxTaskRecordBytes = 4 * 1024 * 1024;
const maxTextChars = 8_000;

export type DurableTaskStatus =
  | "queued"
  | "running"
  | "continuable"
  | "completed"
  | "failed"
  | "aborted"
  | "budget_exhausted";

export type DurableAttemptStatus = "running" | "completed" | "incomplete" | "failed" | "aborted";

export interface DurableTaskAttempt {
  attemptId: string;
  attemptNumber: number;
  status: DurableAttemptStatus;
  startedAt: string;
  endedAt?: string;
  feedback?: string;
  output?: string;
  runtimeSteps: number;
  usage?: SessionUsage;
  stopReason?: string;
  finishReason?: string;
  error?: string;
  toolEvidence: TaskToolEvidence[];
  verifierEvidence: AcceptanceEvidence[];
}

export interface TaskRunSnapshot {
  version: typeof taskRunVersion;
  taskRunId: string;
  sessionId?: string;
  rootRunId?: string;
  objective: string;
  acceptanceCriteria: TaskRequest["acceptanceCriteria"];
  pendingTodo: string[];
  budget: TaskAttemptBudget;
  status: DurableTaskStatus;
  createdAt: string;
  updatedAt: string;
  attempts: DurableTaskAttempt[];
  terminalReason?: string;
  recovered?: boolean;
}

export interface CreateTaskRunOptions {
  taskRunId?: string;
  sessionId?: string;
  rootRunId?: string;
  request: TaskRequest;
  budget: TaskAttemptBudget;
}

export interface CompleteTaskAttemptOptions {
  status: Exclude<DurableAttemptStatus, "running">;
  output?: string;
  runtimeSteps: number;
  usage?: SessionUsage;
  stopReason?: string;
  finishReason?: string;
  error?: string;
  toolEvidence?: TaskToolEvidence[];
}

interface DirectoryIdentity {
  device: number;
  inode: number;
}

/** Durable task truth that survives conversation compaction and process restarts. */
export class TaskRunStore {
  readonly directoryPath: string;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly persistenceRoot: string,
    directoryPath: string,
    private readonly directoryIdentity: DirectoryIdentity
  ) {
    this.directoryPath = directoryPath;
  }

  static async open(persistenceRoot: string): Promise<TaskRunStore> {
    await ensureAgentDirs(persistenceRoot);
    const canonicalRoot = await fs.realpath(path.resolve(persistenceRoot));
    const directoryPath = path.join(canonicalRoot, ".agent", "tasks");
    const canonicalTasks = await fs.realpath(directoryPath);
    if (canonicalTasks !== directoryPath) throw new Error("Task storage resolves outside the canonical persistence root.");
    const stat = await fs.lstat(canonicalTasks);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Task storage .agent/tasks must be a real directory, not a symbolic link.");
    }
    const store = new TaskRunStore(canonicalRoot, canonicalTasks, { device: stat.dev, inode: stat.ino });
    await store.recoverInterruptedRuns();
    return store;
  }

  async create(options: CreateTaskRunOptions): Promise<TaskRunSnapshot> {
    return await this.withWrite(async () => {
      const taskRunId = options.taskRunId ?? randomUUID();
      assertTaskRunId(taskRunId);
      validateBudget(options.budget);
      const objective = publicText(options.request.objective);
      if (!objective) throw new Error("Task objective cannot be empty.");
      const now = new Date().toISOString();
      const snapshot: TaskRunSnapshot = {
        version: taskRunVersion,
        taskRunId,
        sessionId: optionalPublicText(options.sessionId),
        rootRunId: optionalPublicText(options.rootRunId),
        objective,
        acceptanceCriteria: cloneCriteria(options.request.acceptanceCriteria),
        pendingTodo: publicStringList(options.request.pendingTodo ?? []),
        budget: cloneBudget(options.budget),
        status: "queued",
        createdAt: now,
        updatedAt: now,
        attempts: [],
        terminalReason: undefined,
        recovered: undefined
      };
      await this.writeSnapshot(snapshot, true);
      return cloneSnapshot(snapshot);
    });
  }

  async markRunning(taskRunId: string): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      if (isTerminal(snapshot.status)) throw new Error(`Task run ${taskRunId} is already terminal (${snapshot.status}).`);
      snapshot.status = "running";
      snapshot.terminalReason = undefined;
      snapshot.recovered = undefined;
    });
  }

  async startAttempt(
    taskRunId: string,
    attempt: { attemptId: string; attemptNumber: number; feedback?: string }
  ): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      if (isTerminal(snapshot.status)) throw new Error(`Task run ${taskRunId} is already terminal (${snapshot.status}).`);
      if (snapshot.attempts.some((item) => item.attemptId === attempt.attemptId)) {
        throw new Error(`Task attempt already exists: ${attempt.attemptId}`);
      }
      if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
        throw new Error("Attempt number must be a positive safe integer.");
      }
      snapshot.status = "running";
      snapshot.attempts.push({
        attemptId: publicText(attempt.attemptId),
        attemptNumber: attempt.attemptNumber,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: undefined,
        feedback: optionalPublicText(attempt.feedback),
        output: undefined,
        runtimeSteps: 0,
        usage: undefined,
        stopReason: undefined,
        finishReason: undefined,
        error: undefined,
        toolEvidence: [],
        verifierEvidence: []
      });
    });
  }

  async completeAttempt(
    taskRunId: string,
    attemptId: string,
    result: CompleteTaskAttemptOptions
  ): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      const attempt = requiredAttempt(snapshot, attemptId);
      if (attempt.status !== "running") throw new Error(`Task attempt ${attemptId} is already ${attempt.status}.`);
      if (!Number.isSafeInteger(result.runtimeSteps) || result.runtimeSteps < 0) {
        throw new Error("Attempt runtimeSteps must be a non-negative safe integer.");
      }
      attempt.status = result.status;
      attempt.endedAt = new Date().toISOString();
      attempt.output = optionalPublicText(result.output);
      attempt.runtimeSteps = result.runtimeSteps;
      attempt.usage = cloneUsage(result.usage);
      attempt.stopReason = optionalPublicText(result.stopReason);
      attempt.finishReason = optionalPublicText(result.finishReason);
      attempt.error = optionalPublicText(result.error);
      attempt.toolEvidence = cloneToolEvidence(result.toolEvidence ?? []);
    });
  }

  async recordVerification(
    taskRunId: string,
    attemptId: string,
    evidence: AcceptanceEvidence[]
  ): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      requiredAttempt(snapshot, attemptId).verifierEvidence = cloneAcceptanceEvidence(evidence);
    });
  }

  async setPendingTodo(taskRunId: string, pendingTodo: string[]): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      snapshot.pendingTodo = publicStringList(pendingTodo);
    });
  }

  async finish(
    taskRunId: string,
    status: Extract<DurableTaskStatus, "completed" | "failed" | "aborted" | "budget_exhausted" | "continuable">,
    terminalReason: string
  ): Promise<TaskRunSnapshot> {
    return await this.mutate(taskRunId, (snapshot) => {
      if (isTerminal(snapshot.status)) {
        if (snapshot.status === status && snapshot.terminalReason === publicText(terminalReason)) return;
        throw new Error(`Task run ${taskRunId} is already terminal (${snapshot.status}).`);
      }
      snapshot.status = status;
      snapshot.terminalReason = publicText(terminalReason);
    });
  }

  async get(taskRunId: string): Promise<TaskRunSnapshot> {
    await this.writeTail;
    assertTaskRunId(taskRunId);
    return cloneSnapshot(await this.readSnapshot(taskRunId));
  }

  async list(): Promise<TaskRunSnapshot[]> {
    await this.writeTail;
    await this.assertDirectoryBinding();
    const entries = await fs.readdir(this.directoryPath, { withFileTypes: true });
    const snapshots: TaskRunSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isTaskFileName(entry.name)) continue;
      snapshots.push(await this.readSnapshot(taskIdFromFileName(entry.name)));
    }
    snapshots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskRunId.localeCompare(left.taskRunId));
    return snapshots.map(cloneSnapshot);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const snapshots = await this.list();
    for (const snapshot of snapshots) {
      if (snapshot.status !== "queued" && snapshot.status !== "running") continue;
      await this.mutate(snapshot.taskRunId, (current) => {
        if (current.status !== "queued" && current.status !== "running") return;
        const now = new Date().toISOString();
        for (const attempt of current.attempts) {
          if (attempt.status !== "running") continue;
          attempt.status = "incomplete";
          attempt.endedAt = now;
          attempt.stopReason = "runtime_restart";
          attempt.error = "Runtime stopped before the attempt reached a terminal result.";
        }
        current.status = "continuable";
        current.recovered = true;
        current.terminalReason = "Runtime restarted before the task completed; the task can be continued.";
      });
    }
  }

  private async mutate(
    taskRunId: string,
    update: (snapshot: TaskRunSnapshot) => void
  ): Promise<TaskRunSnapshot> {
    return await this.withWrite(async () => {
      assertTaskRunId(taskRunId);
      const snapshot = await this.readSnapshot(taskRunId);
      update(snapshot);
      snapshot.updatedAt = new Date().toISOString();
      validateSnapshot(snapshot);
      await this.writeSnapshot(snapshot, false);
      return cloneSnapshot(snapshot);
    });
  }

  private async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readSnapshot(taskRunId: string): Promise<TaskRunSnapshot> {
    await this.assertDirectoryBinding();
    const filePath = this.filePath(taskRunId);
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (isSymlinkError(error)) throw new Error(`Unsafe task record: ${taskRunId}`);
      throw error;
    }
    try {
      await assertFileBinding(filePath, handle);
      const stat = await handle.stat();
      if (stat.size > maxTaskRecordBytes) throw new Error(`Task record exceeds ${String(maxTaskRecordBytes)} bytes: ${taskRunId}`);
      const text = await handle.readFile("utf8");
      await assertFileBinding(filePath, handle);
      const parsed: unknown = JSON.parse(text);
      return parseSnapshot(parsed, taskRunId);
    } finally {
      await handle.close();
    }
  }

  private async writeSnapshot(snapshot: TaskRunSnapshot, create: boolean): Promise<void> {
    validateSnapshot(snapshot);
    await this.assertDirectoryBinding();
    const targetPath = this.filePath(snapshot.taskRunId);
    if (create && await exists(targetPath)) throw new Error(`Task run already exists: ${snapshot.taskRunId}`);
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(text) > maxTaskRecordBytes) throw new Error("Task run record is too large to persist.");
    const temporaryPath = path.join(
      this.directoryPath,
      `.task-run-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
        0o600
      );
      await handle.chmod(0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await assertFileBinding(temporaryPath, handle);
      await this.assertDirectoryBinding();
      if (create) {
        try {
          await fs.link(temporaryPath, targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Task run already exists: ${snapshot.taskRunId}`);
          throw error;
        }
        await fs.unlink(temporaryPath);
      } else {
        const current = await fs.lstat(targetPath);
        if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) throw new Error(`Unsafe task record: ${snapshot.taskRunId}`);
        await fs.rename(temporaryPath, targetPath);
      }
      await this.assertDirectoryBinding();
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private filePath(taskRunId: string): string {
    assertTaskRunId(taskRunId);
    return path.join(this.directoryPath, `${taskFilePrefix}${taskRunId}${taskFileSuffix}`);
  }

  private async assertDirectoryBinding(): Promise<void> {
    const stat = await fs.lstat(this.directoryPath);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || stat.dev !== this.directoryIdentity.device
      || stat.ino !== this.directoryIdentity.inode
      || await fs.realpath(this.directoryPath) !== this.directoryPath
    ) {
      throw new Error("Task storage directory changed during access.");
    }
  }
}

function parseSnapshot(value: unknown, expectedTaskRunId: string): TaskRunSnapshot {
  if (!isRecord(value)) throw new Error(`Invalid task record: ${expectedTaskRunId}`);
  const snapshot = value as unknown as TaskRunSnapshot;
  validateSnapshot(snapshot);
  if (snapshot.taskRunId !== expectedTaskRunId) throw new Error(`Task record id mismatch: ${expectedTaskRunId}`);
  return cloneSnapshot(snapshot);
}

function validateSnapshot(snapshot: TaskRunSnapshot): void {
  if (!isRecord(snapshot) || snapshot.version !== taskRunVersion) throw new Error("Unsupported task record version.");
  assertTaskRunId(snapshot.taskRunId);
  if (typeof snapshot.objective !== "string" || !snapshot.objective.trim()) throw new Error("Task record objective is invalid.");
  if (!Array.isArray(snapshot.acceptanceCriteria) || !Array.isArray(snapshot.pendingTodo) || !Array.isArray(snapshot.attempts)) {
    throw new Error("Task record lists are invalid.");
  }
  validateBudget(snapshot.budget);
  if (!isTaskStatus(snapshot.status)) throw new Error("Task record status is invalid.");
  if (!isTimestamp(snapshot.createdAt) || !isTimestamp(snapshot.updatedAt)) throw new Error("Task record timestamps are invalid.");
  for (const attempt of snapshot.attempts) {
    if (!isRecord(attempt) || typeof attempt.attemptId !== "string" || !attempt.attemptId) throw new Error("Task attempt is invalid.");
    if (!Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) throw new Error("Task attempt number is invalid.");
    if (!isAttemptStatus(attempt.status) || !isTimestamp(attempt.startedAt)) throw new Error("Task attempt lifecycle is invalid.");
    if (!Number.isSafeInteger(attempt.runtimeSteps) || attempt.runtimeSteps < 0) throw new Error("Task attempt step count is invalid.");
    if (!Array.isArray(attempt.toolEvidence) || !Array.isArray(attempt.verifierEvidence)) throw new Error("Task attempt evidence is invalid.");
  }
}

function validateBudget(budget: TaskAttemptBudget): void {
  if (!isRecord(budget) || !Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1) {
    throw new Error("Task maxAttempts must be a positive safe integer.");
  }
  if (budget.maxRuntimeSteps !== undefined && (!Number.isSafeInteger(budget.maxRuntimeSteps) || budget.maxRuntimeSteps < 0)) {
    throw new Error("Task maxRuntimeSteps must be a non-negative safe integer.");
  }
  if (budget.maxWallTimeMs !== undefined && (!Number.isSafeInteger(budget.maxWallTimeMs) || budget.maxWallTimeMs < 0)) {
    throw new Error("Task maxWallTimeMs must be a non-negative safe integer.");
  }
  if (budget.maxTotalTokens !== undefined && (!Number.isSafeInteger(budget.maxTotalTokens) || budget.maxTotalTokens < 0)) {
    throw new Error("Task maxTotalTokens must be a non-negative safe integer.");
  }
  if (budget.maxCostUsd !== undefined && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) {
    throw new Error("Task maxCostUsd must be a non-negative finite number.");
  }
}

function requiredAttempt(snapshot: TaskRunSnapshot, attemptId: string): DurableTaskAttempt {
  const attempt = snapshot.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt) throw new Error(`Unknown task attempt: ${attemptId}`);
  return attempt;
}

function cloneSnapshot(snapshot: TaskRunSnapshot): TaskRunSnapshot {
  return {
    ...snapshot,
    acceptanceCriteria: cloneCriteria(snapshot.acceptanceCriteria),
    pendingTodo: [...snapshot.pendingTodo],
    budget: cloneBudget(snapshot.budget),
    attempts: snapshot.attempts.map((attempt) => ({
      ...attempt,
      usage: cloneUsage(attempt.usage),
      toolEvidence: cloneToolEvidence(attempt.toolEvidence),
      verifierEvidence: cloneAcceptanceEvidence(attempt.verifierEvidence)
    }))
  };
}

function cloneCriteria(criteria: TaskRequest["acceptanceCriteria"]): TaskRequest["acceptanceCriteria"] {
  const cloned = redactSensitiveValue(criteria);
  if (!Array.isArray(cloned)) throw new Error("Task acceptance criteria must be an array.");
  return cloned as TaskRequest["acceptanceCriteria"];
}

function cloneToolEvidence(evidence: TaskToolEvidence[]): TaskToolEvidence[] {
  const cloned = redactSensitiveValue(evidence);
  return Array.isArray(cloned) ? cloned as TaskToolEvidence[] : [];
}

function cloneAcceptanceEvidence(evidence: AcceptanceEvidence[]): AcceptanceEvidence[] {
  const cloned = redactSensitiveValue(evidence);
  return Array.isArray(cloned) ? cloned as AcceptanceEvidence[] : [];
}

function cloneBudget(budget: TaskAttemptBudget): TaskAttemptBudget {
  return {
    maxAttempts: budget.maxAttempts,
    maxRuntimeSteps: budget.maxRuntimeSteps,
    maxWallTimeMs: budget.maxWallTimeMs,
    maxTotalTokens: budget.maxTotalTokens,
    maxCostUsd: budget.maxCostUsd
  };
}

function cloneUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  return usage === undefined ? undefined : { ...usage };
}

function publicStringList(values: string[]): string[] {
  if (!Array.isArray(values)) throw new Error("Task TODO list must be an array.");
  return values.map((value) => {
    if (typeof value !== "string") throw new Error("Task TODO entries must be strings.");
    return publicText(value);
  });
}

function publicText(value: string): string {
  const redacted = redactSecrets(value).trim();
  return redacted.length <= maxTextChars ? redacted : `${redacted.slice(0, maxTextChars - 1)}…`;
}

function optionalPublicText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : publicText(value);
}

function assertTaskRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new Error(`Invalid task run id: ${value}`);
}

function isTaskFileName(value: string): boolean {
  return value.startsWith(taskFilePrefix)
    && value.endsWith(taskFileSuffix)
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(taskIdFromFileName(value));
}

function taskIdFromFileName(value: string): string {
  return value.slice(taskFilePrefix.length, -taskFileSuffix.length);
}

function isTaskStatus(value: unknown): value is DurableTaskStatus {
  return value === "queued" || value === "running" || value === "continuable" || value === "completed" || value === "failed" || value === "aborted" || value === "budget_exhausted";
}

function isAttemptStatus(value: unknown): value is DurableAttemptStatus {
  return value === "running" || value === "completed" || value === "incomplete" || value === "failed" || value === "aborted";
}

function isTerminal(status: DurableTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "budget_exhausted";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function assertFileBinding(filePath: string, handle: FileHandle): Promise<Stats> {
  const [descriptor, target] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
  if (
    !descriptor.isFile()
    || !target.isFile()
    || target.isSymbolicLink()
    || descriptor.dev !== target.dev
    || descriptor.ino !== target.ino
    || target.nlink !== 1
    || await fs.realpath(filePath) !== path.resolve(filePath)
  ) {
    throw new Error("Task record path changed during access.");
  }
  return descriptor;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
