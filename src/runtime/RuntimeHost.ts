/**
 * 交互 Agent 的跨进程 Host。
 *
 * 一个 persistenceRoot 只有一个 owner 持有 InteractiveAgentRuntime；Desktop、TUI
 * 和其它本地客户端通过 Unix domain socket 共享同一份快照、事件序列和控制入口。
 * 这里不复制 Session/Agent 状态，也不把 Desktop IPC 复用成第二套协议。
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAttachment, AgentRunMode, ResumedAgentSession } from "../agent/AgentSession.js";
import type { ContextStatus, MemoryEntry } from "../agent/context/types.js";
import { thinkingLevelSchema } from "../config/schema.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionSummary } from "../session/events.js";
import type { RuntimeCommandResult } from "./commands.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { CommandSurface } from "./commandRegistry.js";
import {
  type AgentRunOutcome,
  type InteractiveAgentHost,
  type InteractiveRuntimeHandle,
  type QueuedAgentMessage,
  type RuntimeRequestIds,
  type SubmittedAgentRun
} from "./InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot, RuntimeOperation } from "./agentEvents.js";
import { executeRuntimeCommand } from "./commands.js";
import { listSessionSummaries } from "../session/events.js";
import { sessionIdFromFile } from "../session/store.js";
import { TurnStore } from "../session/turnStore.js";

const protocolVersion = 1;
const eventHistoryLimit = 4_000;
const maxFrameBytes = 8 * 1024 * 1024;
const reconnectDelayMs = 250;
const maxUnixSocketPathLength = 90;
const hostStartupTimeoutMs = 8_000;
const hostJournalFile = "runtime-host-events.jsonl";

type HostSurface = CommandSurface | "cli";

interface HostRegistration {
  protocolVersion: number;
  endpoint: string;
  registrationPath: string;
  lockPath: string;
  rootHash: string;
  persistenceRoot: string;
  hostEpoch: string;
  token: string;
  pid: number;
  createdAt: string;
}

interface HostHelloFrame {
  kind: "hello";
  requestId: string;
  protocolVersion: number;
  rootHash: string;
  token: string;
  clientId: string;
  surface: HostSurface;
}

interface HostRequestFrame {
  kind: "request";
  requestId: string;
  operation: string;
  payload: unknown;
}

interface HostResponseFrame {
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface HostEventFrame {
  kind: "event";
  hostEpoch: string;
  sequence: number;
  update: AgentRuntimeUpdate;
}

interface HostCompletionFrame {
  kind: "completion";
  runId: string;
  outcome: AgentRunOutcome;
}

interface HostGapFrame {
  kind: "gap";
  hostEpoch: string;
  sequence: number;
  snapshot: InteractiveRuntimeSnapshot;
}

type HostFrame = HostHelloFrame | HostRequestFrame | HostResponseFrame | HostEventFrame | HostCompletionFrame | HostGapFrame;

export interface RuntimeHostSpawnOptions {
  workspaceRoot: string;
  configDir?: string;
  attachmentRoot?: string;
  sessionId?: string;
  resumeInterrupted?: boolean;
  /** Electron 打包时由主进程显式提供；CLI/TUI 会自动推导 source/dist 路径。 */
  entryPath?: string;
}

export interface HostClientOptions {
  clientId?: string;
  surface?: HostSurface;
  /** owner 退出后，client 是否有足够 composition root 重新选举 Host。 */
  spawnOptions?: RuntimeHostSpawnOptions;
}

interface RuntimeHostClientOptions extends HostClientOptions {
  registration: HostRegistration;
}

interface HostConnection {
  socket: net.Socket;
  clientId: string;
  surface: HostSurface;
  subscribed: boolean;
  authenticated: boolean;
  buffer: string;
}

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingCompletion {
  resolve(outcome: AgentRunOutcome): void;
  reject(error: Error): void;
}

interface RuntimeHostPaths {
  endpoint: string;
  registrationPath: string;
  lockPath: string;
  rootHash: string;
}

export interface RuntimeHostInfo {
  endpoint: string;
  hostEpoch: string;
  sequence: number;
  persistenceRoot: string;
}

/** Runtime Host 重建 runtime 时使用的 composition root。 */
export type RuntimeHostFactory = (sessionId?: string) => Promise<InteractiveAgentHost>;

export interface RuntimeHostStartOptions {
  /** 远端请求新会话、配置重载或编辑分支时，按 sessionId 重建 owner。 */
  createRuntime?: RuntimeHostFactory;
  /** owner 进程启动后自动检查并续跑在途 turn。 */
  resumeInterrupted?: boolean;
}

export interface SpawnRuntimeHostOptions extends HostClientOptions, RuntimeHostSpawnOptions {}

export interface SpawnedRuntimeHost {
  process: ChildProcess;
  client: RuntimeHostClient;
}

/** 计算本机 runtime 的发现信息；socket 本身放在用户临时目录，不写入项目目录。 */
export function runtimeHostPaths(persistenceRoot: string): RuntimeHostPaths {
  const resolvedRoot = path.resolve(persistenceRoot);
  const rootHash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 24);
  const baseName = `biny-${rootHash}`;
  const temporaryRoot = os.tmpdir();
  const preferred = path.join(temporaryRoot, `${baseName}.sock`);
  // macOS 的临时目录有时很深，Unix socket 路径过长会直接返回 ENAMETOOLONG。
  const endpoint = preferred.length <= maxUnixSocketPathLength
    ? preferred
    : path.join("/tmp", `${baseName}.sock`);
  return {
    endpoint,
    registrationPath: `${endpoint}.json`,
    lockPath: `${endpoint}.lock`,
    rootHash
  };
}

/** 连接现有 Host；没有注册信息或发现的是已退出的 owner 时返回 undefined。 */
export async function connectRuntimeHost(
  persistenceRoot: string,
  options: HostClientOptions = {}
): Promise<RuntimeHostClient | undefined> {
  if (process.platform === "win32") return undefined;
  const paths = runtimeHostPaths(persistenceRoot);
  const registration = await readRegistration(paths);
  if (!registration) return undefined;
  try {
    return await RuntimeHostClient.connect({
      registration,
      clientId: options.clientId,
      surface: options.surface,
      spawnOptions: options.spawnOptions
    });
  } catch (error) {
    if (!isConnectionRefused(error)) throw error;
    if (isProcessAlive(registration.pid)) return undefined;
    await removeStaleRegistration(registration);
    return undefined;
  }
}

/** 先 attach，找不到 owner 时启动一个独立 Node Host 再 attach。 */
export async function connectOrSpawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<RuntimeHostClient | undefined> {
  const spawnOptions = toSpawnOptions(options);
  const attached = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions
  });
  if (attached) return attached;
  const spawned = await spawnRuntimeHost(persistenceRoot, options);
  return spawned.client;
}

/** 启动独立 Host 进程，并等待 registration/socket 真正可用。 */
export async function spawnRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions
): Promise<SpawnedRuntimeHost> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const child = spawnRuntimeHostProcess(persistenceRoot, options);
  const client = await waitForSpawnedRuntimeHost(persistenceRoot, options, child);
  return { process: child, client };
}

/** 只启动 owner 进程；用于已有 client 在断线后重新选举，不重复创建第二个 client。 */
export function spawnRuntimeHostProcess(
  persistenceRoot: string,
  options: RuntimeHostSpawnOptions
): ChildProcess {
  const entryPath = options.entryPath ?? process.env.BINY_RUNTIME_HOST_ENTRY ?? runtimeHostEntryPath();
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const nodeArgs = entryPath.endsWith(".ts") ? ["--import", "tsx", entryPath] : [entryPath];
  const child = spawn(process.execPath, [
    ...nodeArgs,
    "--workspace-root",
    path.resolve(options.workspaceRoot),
    "--persistence-root",
    path.resolve(persistenceRoot),
    ...(options.configDir === undefined ? [] : ["--config-dir", path.resolve(options.configDir)]),
    ...(options.attachmentRoot === undefined ? [] : ["--attachment-root", path.resolve(options.attachmentRoot)]),
    ...(options.sessionId === undefined ? [] : ["--session-id", options.sessionId]),
    ...(options.resumeInterrupted === false ? [] : ["--resume-interrupted"])
  ], {
    cwd: moduleRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" })
    }
  });
  child.unref();
  return child;
}

/** 在途状态按最近更新的会话选择；显式 sessionId 仍由调用方优先。 */
export async function findLatestInterruptedSession(persistenceRoot: string): Promise<string | undefined> {
  const summaries = await listSessionSummaries(persistenceRoot);
  for (const summary of summaries) {
    const sessionId = sessionIdFromFile(summary.fileName);
    if (await new TurnStore(persistenceRoot, sessionId).load()) return sessionId;
  }
  return undefined;
}

/** 当前进程创建 owner Host。若另一个 owner 抢先成功，调用方应关闭本地 runtime 后重连。 */
export async function startRuntimeHost(
  persistenceRoot: string,
  runtime: InteractiveRuntimeHandle,
  commands: CommandRuntime,
  options: RuntimeHostStartOptions = {}
): Promise<RuntimeHostServer> {
  if (process.platform === "win32") throw new Error("Runtime Host currently requires Unix domain sockets.");
  const paths = runtimeHostPaths(persistenceRoot);
  const lock = await acquireHostLock(paths, persistenceRoot);
  const hostEpoch = randomUUID();
  const token = randomUUID();
  const registration: HostRegistration = {
    protocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: path.resolve(persistenceRoot),
    hostEpoch,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  let server: RuntimeHostServer | undefined;
  try {
    await removeSocketIfStale(paths.endpoint);
    server = new RuntimeHostServer(runtime, commands, registration, lock, options.createRuntime);
    await server.initialize();
    await server.listen();
    await writeRegistration(registration);
    if (options.resumeInterrupted) await server.resumeInterruptedTurn();
    return server;
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (!server) await lock.close().catch(() => undefined);
    await removeStaleRegistration(registration).catch(() => undefined);
    throw error;
  }
}

/** Runtime owner 的本地 server。一个 server 可以被多个 Desktop/TUI client 订阅。 */
export class RuntimeHostServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly connections = new Set<HostConnection>();
  private readonly history: Array<{ sequence: number; update: AgentRuntimeUpdate }> = [];
  private readonly journalPath: string;
  private sequence = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private journalTail: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  private runtime: InteractiveRuntimeHandle;
  private commands: CommandRuntime;
  private readonly createRuntime: RuntimeHostFactory | undefined;
  private closePromise: Promise<void> | undefined;
  private listening = false;
  private initialized = false;

  constructor(
    runtime: InteractiveRuntimeHandle,
    commands: CommandRuntime,
    private readonly registration: HostRegistration,
    private readonly lock: FileHandle,
    createRuntime?: RuntimeHostFactory
  ) {
    this.runtime = runtime;
    this.commands = commands;
    this.createRuntime = createRuntime;
    this.journalPath = path.join(registration.persistenceRoot, ".biny", "runs", hostJournalFile);
    this.unsubscribe = runtime.subscribe((update) => this.publish(update));
  }

  get info(): RuntimeHostInfo {
    return {
      endpoint: this.registration.endpoint,
      hostEpoch: this.registration.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.registration.persistenceRoot
    };
  }

  /** 载入最近的持久事件；session JSONL 和 turnStore 仍是恢复事实来源。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const currentSessionId = this.runtime.getSnapshot().info.sessionId;
    try {
      const text = await fs.readFile(this.journalPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as unknown;
          const parsed = asRecord(record);
          const sequence = parsed.sequence;
          const update = parsed.update;
          if (!Number.isSafeInteger(sequence) || !isRuntimeUpdate(update)) continue;
          this.sequence = Math.max(this.sequence, sequence as number);
          if (update.snapshot.info.sessionId === currentSessionId) {
            this.history.push({ sequence: sequence as number, update });
          }
        } catch {
          // 单行损坏只影响该行；新的事件仍可继续追加。
        }
      }
      if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.initialized = true;
  }

  /** Host owner 启动后的自动续跑；无断点时是 no-op。 */
  async resumeInterruptedTurn(): Promise<void> {
    const submitted = await this.runtime.startInterruptedTurn();
    if (submitted) this.trackCompletion(submitted);
  }

  /** 独立 Host 进程退出时同时关闭当前 owner runtime。 */
  async closeOwner(): Promise<void> {
    const runtime = this.runtime;
    await this.close();
    await runtime.close();
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        this.listening = true;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.registration.endpoint);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = (async () => {
      this.unsubscribe();
      for (const connection of this.connections) connection.socket.destroy();
      this.connections.clear();
      if (this.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        this.listening = false;
      }
      await this.journalTail;
      await removeRegistration(this.registration);
      await this.lock.close();
    })();
    return await this.closePromise;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    const connection: HostConnection = {
      socket,
      clientId: "",
      surface: "cli",
      subscribed: false,
      authenticated: false,
      buffer: ""
    };
    this.connections.add(connection);
    socket.on("data", (chunk: string) => this.read(connection, chunk));
    socket.once("close", () => {
      this.connections.delete(connection);
    });
    socket.once("error", () => {
      this.connections.delete(connection);
    });
  }

  private read(connection: HostConnection, chunk: string): void {
    connection.buffer += chunk;
    if (Buffer.byteLength(connection.buffer, "utf8") > maxFrameBytes) {
      connection.socket.destroy(new Error("Runtime Host frame is too large."));
      return;
    }
    while (true) {
      const newline = connection.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        connection.socket.destroy(new Error("Invalid Runtime Host JSON frame."));
        return;
      }
      void this.handleFrame(connection, frame);
    }
  }

  private async handleFrame(connection: HostConnection, frame: unknown): Promise<void> {
    if (!connection.authenticated) {
      if (!isHelloFrame(frame)) {
        connection.socket.destroy(new Error("Runtime Host handshake required."));
        return;
      }
      if (
        frame.protocolVersion !== protocolVersion
        || frame.rootHash !== this.registration.rootHash
        || frame.token !== this.registration.token
      ) {
        connection.socket.destroy(new Error("Runtime Host handshake rejected."));
        return;
      }
      connection.authenticated = true;
      connection.clientId = frame.clientId;
      connection.surface = frame.surface;
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: true,
        result: {
          hostEpoch: this.registration.hostEpoch,
          persistenceRoot: this.registration.persistenceRoot,
          sequence: this.sequence
        }
      });
      return;
    }
    if (!isRequestFrame(frame)) {
      connection.socket.destroy(new Error("Invalid Runtime Host request."));
      return;
    }
    try {
      const result = await this.enqueue(async () => await this.execute(connection, frame));
      this.send(connection, { kind: "response", requestId: frame.requestId, ok: true, result });
    } catch (error) {
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: false,
        error: publicError(error)
      });
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(work, work);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute(connection: HostConnection, frame: HostRequestFrame): Promise<unknown> {
    const payload = asRecord(frame.payload);
    switch (frame.operation) {
      case "snapshot":
        return { snapshot: this.runtime.getSnapshot(), sequence: this.sequence };
      case "subscribe":
        return this.subscribeConnection(
          connection,
          optionalSafeInteger(payload.afterSequence),
          optionalString(payload.afterHostEpoch)
        );
      case "submit": {
        this.assertRevision(payload);
        const ids = readRequestIds(payload);
        const submitted = this.runtime.submitPrompt(
          requiredString(payload.input, "input"),
          readRunMode(payload.mode),
          readAttachments(payload.attachments),
          ids
        );
        this.trackCompletion(submitted);
        return {
          runId: submitted.runId,
          messageId: submitted.messageId
        };
      }
      case "queue": {
        this.assertRevision(payload);
        const ids = readRequestIds(payload);
        const input = requiredString(payload.input, "input");
        const attachments = readAttachments(payload.attachments);
        const delivery = payload.delivery === "steer" ? "steer" : "followUp";
        const queued = delivery === "steer"
          ? this.runtime.steer(input, attachments, ids)
          : this.runtime.followUp(input, attachments, ids);
        return queued;
      }
      case "resume":
        this.assertRevision(payload);
        return await this.runtime.resumeSession(requiredString(payload.session, "session"));
      case "start-interrupted": {
        this.assertRevision(payload);
        const submitted = await this.runtime.startInterruptedTurn(readRequestIds(payload));
        if (submitted) this.trackCompletion(submitted);
        return submitted === undefined
          ? undefined
          : { runId: submitted.runId, messageId: submitted.messageId };
      }
      case "cancel": {
        this.assertRevision(payload);
        const runId = optionalString(payload.runId);
        return runId === undefined ? (this.runtime.cancelCurrentRun(), true) : this.runtime.cancelRun(runId);
      }
      case "permission":
        this.assertRevision(payload);
        this.runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
        return undefined;
      case "wait-idle":
        await this.runtime.waitForIdle();
        return undefined;
      case "compact":
        this.assertRevision(payload);
        return await this.runtime.compactConversation(optionalString(payload.hint));
      case "command": {
        this.assertRevision(payload);
        const source = readSurface(payload.source ?? connection.surface);
        const result = await executeRuntimeCommand(
          this.runtime,
          this.commands,
          requiredString(payload.input, "input"),
          source === "desktop" ? "desktop" : "tui"
        );
        return result;
      }
      case "agent.context":
        return await this.commands.agent.contextStatus();
      case "agent.usage":
        return { summary: this.commands.agent.usageSummary(), report: this.commands.agent.usageReport() };
      case "agent.models":
        return this.commands.agent.listModels();
      case "agent.refresh-model":
        this.assertRevision(payload);
        return await this.runtime.runExclusiveOperation("refresh_model", async () => await this.commands.agent.refreshModelFromDisk());
      case "agent.switch-model":
        this.assertRevision(payload);
        return await this.runtime.runExclusiveOperation(
          "switch_model",
          async () => await this.commands.agent.switchModel(requiredString(payload.alias, "alias"), readThinking(payload.thinking))
        );
      case "agent.permission-mode":
        this.assertRevision(payload);
        await this.runtime.runExclusiveOperation(
          "permission",
          async () => await this.commands.agent.setPermissionMode(readPermissionMode(payload.mode))
        );
        return this.runtime.getSnapshot().permissionMode;
      case "agent.permission-command":
        this.assertRevision(payload);
        return await this.runtime.runExclusiveOperation(
          "permission",
          async () => await this.commands.agent.runPermissionCommand(readStringArray(payload.args, "args"))
        );
      case "agent.sessions":
        return await this.commands.agent.listSessions();
      case "skills.list":
        return this.commands.listSkills();
      case "skills.expand":
        return await this.commands.expandSkillCommand(requiredString(payload.input, "input"));
      case "memory":
        return await this.executeMemory(payload);
      case "runtime.restart":
        this.assertRevision(payload);
        return await this.restartRuntime(optionalString(payload.sessionId));
      case "host.info":
        return this.info;
      default:
        throw new Error(`Unknown Runtime Host operation: ${frame.operation}`);
    }
  }

  private subscribeConnection(
    connection: HostConnection,
    afterSequence: number | undefined,
    afterHostEpoch: string | undefined
  ): { hostEpoch: string; snapshot: InteractiveRuntimeSnapshot; sequence: number; replayed: boolean } {
    connection.subscribed = true;
    const sameEpoch = afterHostEpoch === undefined || afterHostEpoch === this.registration.hostEpoch;
    const replayed = sameEpoch && (afterSequence === undefined || this.canReplay(afterSequence));
    if (afterSequence === undefined && sameEpoch) {
      for (const item of this.history) this.sendEvent(connection, item.sequence, item.update);
    } else if (replayed && afterSequence !== undefined) {
      for (const item of this.history) {
        if (item.sequence > afterSequence) {
          this.sendEvent(connection, item.sequence, item.update);
        }
      }
    } else if (!replayed) {
      this.send(connection, {
        kind: "gap",
        hostEpoch: this.registration.hostEpoch,
        sequence: this.sequence,
        snapshot: this.runtime.getSnapshot()
      });
    }
    return { hostEpoch: this.registration.hostEpoch, snapshot: this.runtime.getSnapshot(), sequence: this.sequence, replayed };
  }

  private canReplay(afterSequence: number): boolean {
    if (afterSequence >= this.sequence) return true;
    const first = this.history[0]?.sequence;
    return first !== undefined && afterSequence >= first - 1;
  }

  private publish(update: AgentRuntimeUpdate): void {
    this.sequence += 1;
    const sequence = this.sequence;
    this.history.push({ sequence, update });
    if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    const compactedJournal = sequence % eventHistoryLimit === 0
      ? this.history.map((item) => JSON.stringify(item)).join("\n") + "\n"
      : undefined;
    this.journalTail = this.journalTail
      .then(async () => {
        if (compactedJournal !== undefined) await fs.writeFile(this.journalPath, compactedJournal, { mode: 0o600 });
        else await fs.appendFile(this.journalPath, `${JSON.stringify({ sequence, update })}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed) this.sendEvent(connection, sequence, update);
    }
  }

  private sendEvent(connection: HostConnection, sequence: number, update: AgentRuntimeUpdate): void {
    this.send(connection, { kind: "event", hostEpoch: this.registration.hostEpoch, sequence, update });
  }

  private trackCompletion(submitted: SubmittedAgentRun): void {
    void submitted.completion.then(
      (outcome) => this.broadcastCompletion(submitted.runId, outcome),
      () => undefined
    );
  }

  private broadcastCompletion(runId: string, outcome: AgentRunOutcome): void {
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed) this.send(connection, { kind: "completion", runId, outcome });
    }
  }

  private async executeMemory(payload: Record<string, unknown>): Promise<unknown> {
    const memory = this.commands.agent.getLocalMemory();
    if (!memory) throw new Error("Local memory is disabled (context.memory.enabled = false).");
    const action = requiredString(payload.action, "action");
    if (action !== "list" && action !== "search") this.assertRevision(payload);
    if (action === "list") return await memory.listEntries();
    if (action === "search") return await memory.findRelevant(requiredString(payload.query, "query"), [], 8);
    if (action === "write") return await memory.write(readMemoryEntry(payload.entry));
    if (action === "delete") return await memory.deleteEntry(requiredString(payload.topic, "topic"), requiredInteger(payload.index, "index"));
    if (action === "clear") {
      for (const topic of await memory.listTopics()) await memory.forgetTopic(topic);
      return undefined;
    }
    if (action === "compact") return await memory.compactTopics();
    throw new Error(`Unknown memory operation: ${action}`);
  }

  private assertRevision(payload: Record<string, unknown>): void {
    const expected = optionalSafeInteger(payload.expectedRevision);
    if (expected === undefined) return;
    const current = this.runtime.getSnapshot().revision;
    if (expected !== current) {
      throw new Error(`Runtime Host revision conflict: expected ${String(expected)}, current ${String(current)}.`);
    }
  }

  private async restartRuntime(sessionId: string | undefined): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    if (!this.createRuntime) throw new Error("Runtime Host owner cannot rebuild its runtime.");
    if (this.runtime.getSnapshot().state.kind !== "idle") throw new Error("Cannot rebuild the Runtime Host while it is busy.");
    const next = await this.createRuntime(sessionId);
    const previous = this.runtime;
    this.unsubscribe();
    this.runtime = next.runtime;
    this.commands = next.commands;
    this.unsubscribe = next.runtime.subscribe((update) => this.publish(update));
    await previous.close();
    this.history.splice(0);
    this.publish({ snapshot: this.runtime.getSnapshot() });
    return { snapshot: this.runtime.getSnapshot(), sequence: this.sequence };
  }

  private send(connection: HostConnection, frame: HostFrame): void {
    if (connection.socket.destroyed) return;
    connection.socket.write(`${JSON.stringify(frame)}\n`);
  }
}

/** 可重连的 owner client。实时事件使用 host sequence，重连后优先从内存历史补发。 */
export class RuntimeHostClient implements InteractiveRuntimeHandle {
  readonly persistenceRoot: string;
  private socket: net.Socket | undefined;
  private buffer = "";
  private readyPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly listeners = new Set<(update: AgentRuntimeUpdate) => void>();
  private readonly pendingUpdates: AgentRuntimeUpdate[] = [];
  private snapshot: InteractiveRuntimeSnapshot | undefined;
  private sequence = 0;
  private hostEpoch: string | undefined;
  private closed = false;
  private lastError: Error | undefined;
  private reconnectInProgress = false;
  private ownerRestartPromise: Promise<void> | undefined;

  private constructor(private readonly options: RuntimeHostClientOptions) {
    this.persistenceRoot = options.registration.persistenceRoot;
  }

  static async connect(options: RuntimeHostClientOptions): Promise<RuntimeHostClient> {
    const client = new RuntimeHostClient(options);
    await client.open();
    return client;
  }

  get hostInfo(): RuntimeHostInfo | undefined {
    if (!this.hostEpoch) return undefined;
    return {
      endpoint: this.options.registration.endpoint,
      hostEpoch: this.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.persistenceRoot
    };
  }

  submitPrompt(input: string, mode: AgentRunMode = "chat", attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): SubmittedAgentRun {
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    void this.request<{ runId: string; messageId: string }>("submit", {
      input,
      mode,
      attachments,
      runId: ids.runId,
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    })
      .catch((error) => this.rejectCompletion(ids.runId, error));
    return { runId: ids.runId, messageId: ids.messageId, completion };
  }

  steer(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): QueuedAgentMessage {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    void this.request("queue", {
      input,
      attachments,
      delivery: "steer",
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    }).catch((error) => this.reportError(error));
    return { runId: this.activeRunId() ?? "", messageId: ids.messageId, delivery: "steer" };
  }

  followUp(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): QueuedAgentMessage {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    void this.request("queue", {
      input,
      attachments,
      delivery: "followUp",
      messageId: ids.messageId,
      expectedRevision: this.currentRevision()
    }).catch((error) => this.reportError(error));
    return { runId: this.activeRunId() ?? "", messageId: ids.messageId, delivery: "followUp" };
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    const submitted = await this.startInterruptedTurn();
    return submitted?.completion;
  }

  async startInterruptedTurn(requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined> {
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    let result: { runId: string; messageId: string } | undefined;
    try {
      result = await this.request<{ runId: string; messageId: string } | undefined>("start-interrupted", {
        runId: ids.runId,
        messageId: ids.messageId,
        expectedRevision: this.currentRevision()
      });
    } catch (error) {
      this.rejectCompletion(ids.runId, error);
      throw error;
    }
    if (!result) {
      this.completions.delete(ids.runId);
      return undefined;
    }
    return { runId: result.runId, messageId: result.messageId, completion };
  }

  async waitForIdle(): Promise<void> {
    if (!this.snapshot || this.snapshot.state.kind === "idle") return;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe((update) => {
        if (update.snapshot.state.kind === "idle") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  cancelCurrentRun(): void {
    void this.request("cancel", { expectedRevision: this.currentRevision() }).catch((error) => this.reportError(error));
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRunId();
    if (active !== runId) return false;
    void this.request("cancel", { runId, expectedRevision: this.currentRevision() }).catch((error) => this.reportError(error));
    return true;
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    void this.request("permission", { requestId, result, expectedRevision: this.currentRevision() }).catch((error) => this.reportError(error));
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    return await this.request<ResumedAgentSession>("resume", { session, expectedRevision: this.currentRevision() });
  }

  async runExclusiveOperation<T>(_operation: RuntimeOperation, _execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    throw new Error("Remote runtime operations must use the Runtime Host command methods.");
  }

  startBackgroundOperation<T extends { completion: Promise<unknown> }>(
    _operation: RuntimeOperation,
    _start: (signal: AbortSignal) => T
  ): T {
    throw new Error("Remote background operations must use executeCommand().");
  }

  async compactConversation(hint?: string): Promise<string> {
    return await this.request<string>("compact", { hint, expectedRevision: this.currentRevision() });
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    if (!this.snapshot) throw this.lastError ?? new Error("Runtime Host snapshot is not ready.");
    return this.snapshot;
  }

  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.pendingUpdates.length) {
      const updates = this.pendingUpdates.splice(0);
      for (const update of updates) listener(update);
    }
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("Runtime Host client closed."));
    this.pending.clear();
    this.rejectCompletions(new Error("Runtime Host client closed."));
    this.socket?.destroy();
    this.socket = undefined;
    return Promise.resolve();
  }

  async executeCommand(input: string, source: HostSurface): Promise<RuntimeCommandResult | undefined> {
    return await this.request<RuntimeCommandResult | undefined>("command", { input, source, expectedRevision: this.currentRevision() });
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.request<ContextStatus>("agent.context", {});
  }

  async usage(): Promise<{ summary: unknown; report: string }> {
    return await this.request<{ summary: unknown; report: string }>("agent.usage", {});
  }

  async listModels(): Promise<ModelChoice[]> {
    return await this.request<ModelChoice[]>("agent.models", {});
  }

  async refreshModel(): Promise<ModelRuntimeInfo> {
    return await this.request<ModelRuntimeInfo>("agent.refresh-model", { expectedRevision: this.currentRevision() });
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    try {
      return await this.request<ModelRuntimeInfo>("agent.switch-model", { alias, thinking, expectedRevision: this.currentRevision() });
    } catch (error) {
      // 旧版 detached Host 可能仍在运行；它的协议版本相同，但 thinking schema
      // 不认识新加入的 max。桌面/TUI 具备 spawn composition root 时，空闲状态下
      // 先替换 owner，再用同一请求重试，避免让用户手动寻找并结束旧进程。
      if (!isRuntimeHostThinkingSelectionError(error) || this.options.spawnOptions === undefined) throw error;
      await this.restartOwner();
      return await this.request<ModelRuntimeInfo>("agent.switch-model", { alias, thinking, expectedRevision: this.currentRevision() });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.request("agent.permission-mode", { mode, expectedRevision: this.currentRevision() });
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    return await this.request<string>("agent.permission-command", { args, expectedRevision: this.currentRevision() });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.request<SessionSummary[]>("agent.sessions", {});
  }

  async listSkills(): Promise<Awaited<ReturnType<CommandRuntime["listSkills"]>>> {
    return await this.request("skills.list", {});
  }

  async expandSkillCommand(input: string): Promise<string> {
    return await this.request<string>("skills.expand", { input });
  }

  async memory<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return await this.request<T>("memory", { action, ...payload, expectedRevision: this.currentRevision() });
  }

  /** 让 owner 按指定会话或新会话重建 AgentSession。 */
  async restartRuntime(sessionId?: string): Promise<InteractiveRuntimeSnapshot> {
    const result = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("runtime.restart", {
      sessionId,
      expectedRevision: this.currentRevision()
    });
    this.snapshot = result.snapshot;
    this.sequence = result.sequence;
    return result.snapshot;
  }

  /** 在运行时空闲时替换驻留 owner，供协议兼容修复和桌面恢复使用。 */
  async restartOwner(): Promise<void> {
    if (this.ownerRestartPromise) return await this.ownerRestartPromise;
    const replacement = this.replaceOwner();
    this.ownerRestartPromise = replacement;
    try {
      await replacement;
    } finally {
      if (this.ownerRestartPromise === replacement) this.ownerRestartPromise = undefined;
    }
  }

  private async open(): Promise<void> {
    await this.openSocket();
    const result = await this.request<{ hostEpoch: string; persistenceRoot: string; snapshot: InteractiveRuntimeSnapshot; sequence: number }>("subscribe", { afterSequence: undefined });
    this.hostEpoch = result.hostEpoch;
    this.sequence = result.sequence;
    this.snapshot = result.snapshot;
    if (!this.snapshot) {
      const snapshot = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("snapshot", {});
      this.snapshot = snapshot.snapshot;
      this.sequence = snapshot.sequence;
    }
  }

  private openSocket(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.options.registration.endpoint);
      this.socket = socket;
      socket.setEncoding("utf8");
      const helloRequestId = randomUUID();
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          this.pending.delete(helloRequestId);
          this.readyPromise = undefined;
          reject(error);
        }
      };
      socket.on("connect", () => {
        this.send(socket, {
          kind: "hello",
          requestId: helloRequestId,
          protocolVersion,
          rootHash: this.options.registration.rootHash,
          token: this.options.registration.token,
          clientId: this.options.clientId ?? randomUUID(),
          surface: this.options.surface ?? "cli"
        });
      });
      socket.on("data", (chunk: string) => this.readClientData(chunk));
      socket.once("error", (error: Error) => {
        this.lastError = error;
        fail(error);
      });
      socket.once("close", () => {
        if (!settled) fail(new Error("Runtime Host connection closed during handshake."));
        const error = new Error("Runtime Host connection closed.");
        this.rejectPendingRequests(error);
        if (!this.closed) this.rejectCompletions(error);
        this.socket = undefined;
        this.readyPromise = undefined;
        if (!this.closed && !this.reconnectInProgress) this.scheduleReconnect();
      });
      this.pending.set(helloRequestId, {
        resolve: (value) => {
          settled = true;
          const result = value as { hostEpoch: string; persistenceRoot: string; sequence: number };
          this.hostEpoch = result.hostEpoch;
          this.sequence = result.sequence;
          resolve();
        },
        reject: fail
      });
    });
    return this.readyPromise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect().catch(() => this.scheduleReconnect());
    }, reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    let registration = await readRegistration(runtimeHostPaths(this.persistenceRoot));
    if (registration && !isProcessAlive(registration.pid)) {
      await removeStaleRegistration(registration);
      registration = undefined;
    }
    if (!registration && this.options.spawnOptions) {
      const child = spawnRuntimeHostProcess(this.persistenceRoot, this.options.spawnOptions);
      registration = await waitForHostRegistration(this.persistenceRoot, child);
    }
    if (!registration) throw new Error("Runtime Host registration is not available.");
    const previousHostEpoch = this.hostEpoch;
    this.options.registration = registration;
    await this.openSocket();
    const result = await this.request<{ hostEpoch: string; snapshot: InteractiveRuntimeSnapshot; sequence: number; replayed: boolean }>("subscribe", {
      afterSequence: this.sequence,
      afterHostEpoch: previousHostEpoch
    });
    this.hostEpoch = result.hostEpoch;
    this.snapshot = result.snapshot;
    this.sequence = result.sequence;
  }

  private async replaceOwner(): Promise<void> {
    if (this.closed) throw new Error("Runtime Host client is closed.");
    if (this.options.spawnOptions === undefined) throw new Error("Runtime Host cannot be replaced from this client.");
    const current = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("snapshot", {});
    this.snapshot = current.snapshot;
    this.sequence = current.sequence;
    if (current.snapshot.state.kind !== "idle") throw new Error("Cannot replace the Runtime Host while it is busy.");

    const paths = runtimeHostPaths(this.persistenceRoot);
    const registration = await readRegistration(paths);
    if (!registration) {
      await this.reconnect();
      return;
    }
    if (this.hostEpoch !== undefined && registration.hostEpoch !== this.hostEpoch) {
      await this.reconnect();
      return;
    }
    if (registration.pid === process.pid) throw new Error("Cannot replace a Runtime Host owned by the current process.");

    this.reconnectInProgress = true;
    try {
      try {
        process.kill(registration.pid, "SIGTERM");
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
      await waitForHostExit(paths, registration);
      await this.disconnectSocket();
      await this.reconnect();
    } finally {
      this.reconnectInProgress = false;
    }
  }

  private async disconnectSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.off("close", onClose);
        resolve();
      }, 1_000);
      const onClose = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.once("close", onClose);
      socket.destroy();
    });
  }

  private readClientData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > maxFrameBytes) {
      this.socket?.destroy(new Error("Runtime Host frame is too large."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleClientFrame(JSON.parse(line) as unknown);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private handleClientFrame(frame: unknown): void {
    if (isResponseFrame(frame)) {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error ?? "Runtime Host request failed."));
      return;
    }
    if (isEventFrame(frame)) {
      this.hostEpoch = frame.hostEpoch;
      this.sequence = frame.sequence;
      this.snapshot = frame.update.snapshot;
      if (this.listeners.size) {
        for (const listener of this.listeners) listener(frame.update);
      } else {
        this.pendingUpdates.push(frame.update);
        if (this.pendingUpdates.length > eventHistoryLimit) this.pendingUpdates.splice(0, this.pendingUpdates.length - eventHistoryLimit);
      }
      return;
    }
    if (isCompletionFrame(frame)) {
      const pending = this.completions.get(frame.runId);
      if (!pending) return;
      this.completions.delete(frame.runId);
      pending.resolve(frame.outcome);
      return;
    }
    if (isGapFrame(frame)) {
      this.hostEpoch = frame.hostEpoch;
      this.sequence = frame.sequence;
      this.snapshot = frame.snapshot;
      const update: AgentRuntimeUpdate = { snapshot: frame.snapshot };
      for (const listener of this.listeners) listener(update);
    }
  }

  private request<T>(operation: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Runtime Host client is closed."));
    return this.openSocket().then(() => new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        this.pending.delete(requestId);
        reject(new Error("Runtime Host is disconnected."));
        return;
      }
      this.send(socket, { kind: "request", requestId, operation, payload });
    }));
  }

  private createCompletion(runId: string): Promise<AgentRunOutcome> {
    return new Promise<AgentRunOutcome>((resolve, reject) => this.completions.set(runId, { resolve, reject }));
  }

  private rejectCompletion(runId: string, error: unknown): void {
    const pending = this.completions.get(runId);
    if (!pending) return;
    this.completions.delete(runId);
    pending.reject(asError(error));
  }

  private activeRunId(): string | undefined {
    const state = this.snapshot?.state;
    return state?.kind === "runs" ? state.activeRun.runId : undefined;
  }

  private assertQueueable(input: string, attachments: AgentAttachment[]): void {
    if (!this.activeRunId()) throw new Error("There is no active run to receive a queued message.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
  }

  private reportError(error: unknown): void {
    this.lastError = asError(error);
  }

  private currentRevision(): number | undefined {
    return this.snapshot?.revision;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rejectCompletions(error: Error): void {
    for (const completion of this.completions.values()) completion.reject(error);
    this.completions.clear();
  }

  private send(socket: net.Socket, frame: HostFrame): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }
}

function runtimeHostEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  return path.join(path.dirname(current), `hostProcess${current.endsWith(".ts") ? ".ts" : ".js"}`);
}

async function waitForSpawnedRuntimeHost(
  persistenceRoot: string,
  options: SpawnRuntimeHostOptions,
  child: ChildProcess
): Promise<RuntimeHostClient> {
  await waitForHostRegistration(persistenceRoot, child);
  const client = await connectRuntimeHost(persistenceRoot, {
    clientId: options.clientId,
    surface: options.surface,
    spawnOptions: toSpawnOptions(options)
  });
  if (!client) throw new Error("Runtime Host registration disappeared before attach.");
  return client;
}

function toSpawnOptions(options: SpawnRuntimeHostOptions): RuntimeHostSpawnOptions {
  return {
    workspaceRoot: options.workspaceRoot,
    configDir: options.configDir,
    attachmentRoot: options.attachmentRoot,
    sessionId: options.sessionId,
    resumeInterrupted: options.resumeInterrupted,
    entryPath: options.entryPath
  };
}

async function waitForHostRegistration(
  persistenceRoot: string,
  child: ChildProcess
): Promise<HostRegistration> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < hostStartupTimeoutMs) {
    if (child.exitCode !== null) throw new Error(`Runtime Host process exited before attach (code ${String(child.exitCode)}).`);
    const registration = await readRegistration(runtimeHostPaths(persistenceRoot));
    if (registration) {
      if (isProcessAlive(registration.pid)) return registration;
      await removeStaleRegistration(registration);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode !== null) throw new Error(`Runtime Host process exited before attach (code ${String(child.exitCode)}).`);
  throw new Error(`Runtime Host did not become ready within ${String(hostStartupTimeoutMs)}ms.`);
}

async function waitForHostExit(paths: RuntimeHostPaths, registration: HostRegistration): Promise<void> {
  const deadline = Date.now() + hostStartupTimeoutMs;
  while (Date.now() < deadline) {
    const current = await readRegistration(paths);
    if (!isProcessAlive(registration.pid)) return;
    if (current && current.hostEpoch !== registration.hostEpoch && current.pid !== registration.pid) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Runtime Host process ${String(registration.pid)} did not stop within ${String(hostStartupTimeoutMs)}ms.`);
}

function isHelloFrame(value: unknown): value is HostHelloFrame {
  const record = asRecord(value);
  return record.kind === "hello"
    && typeof record.requestId === "string"
    && record.protocolVersion === protocolVersion
    && typeof record.rootHash === "string"
    && typeof record.token === "string"
    && typeof record.clientId === "string"
    && isSurface(record.surface);
}

function isRequestFrame(value: unknown): value is HostRequestFrame {
  const record = asRecord(value);
  return record.kind === "request" && typeof record.requestId === "string" && typeof record.operation === "string";
}

function isResponseFrame(value: unknown): value is HostResponseFrame {
  const record = asRecord(value);
  return record.kind === "response" && typeof record.requestId === "string" && typeof record.ok === "boolean";
}

function isEventFrame(value: unknown): value is HostEventFrame {
  const record = asRecord(value);
  return record.kind === "event" && typeof record.hostEpoch === "string" && typeof record.sequence === "number" && isRuntimeUpdate(record.update);
}

function isCompletionFrame(value: unknown): value is HostCompletionFrame {
  const record = asRecord(value);
  return record.kind === "completion" && typeof record.runId === "string" && isAgentRunOutcome(record.outcome);
}

function isGapFrame(value: unknown): value is HostGapFrame {
  const record = asRecord(value);
  return record.kind === "gap" && typeof record.hostEpoch === "string" && typeof record.sequence === "number" && isSnapshot(record.snapshot);
}

function isRuntimeUpdate(value: unknown): value is AgentRuntimeUpdate {
  const record = asRecord(value);
  return isSnapshot(record.snapshot);
}

function isSnapshot(value: unknown): value is InteractiveRuntimeSnapshot {
  const record = asRecord(value);
  return typeof record.revision === "number" && typeof record.info === "object" && record.info !== null && typeof record.permissionMode === "string" && typeof record.state === "object" && record.state !== null;
}

function isAgentRunOutcome(value: unknown): value is AgentRunOutcome {
  const record = asRecord(value);
  return typeof record.runId === "string" && typeof record.status === "string" && typeof record.stopReason === "string" && typeof record.steps === "number" && typeof record.durationMs === "number" && typeof record.output === "string";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime Host field ${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Runtime Host field ${name} must be a safe integer.`);
  return value as number;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Runtime Host field ${name} must be a string array.`);
  return value;
}

function readMemoryEntry(value: unknown): MemoryEntry {
  const record = asRecord(value);
  return {
    topic: requiredString(record.topic, "entry.topic"),
    title: requiredString(record.title, "entry.title"),
    summary: requiredString(record.summary, "entry.summary"),
    decisions: readStringArray(record.decisions, "entry.decisions"),
    paths: readStringArray(record.paths, "entry.paths"),
    keywords: readStringArray(record.keywords, "entry.keywords")
  };
}

function readAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Runtime Host attachments must be an array.");
  return value.map((item) => {
    const record = asRecord(item);
    if (typeof record.name !== "string" || typeof record.mimeType !== "string" || typeof record.data !== "string") {
      throw new Error("Runtime Host attachment is invalid.");
    }
    return {
      name: record.name,
      mimeType: record.mimeType,
      data: record.data,
      path: optionalString(record.path),
      size: Number.isSafeInteger(record.size) ? record.size as number : undefined
    };
  });
}

function readRequestIds(payload: Record<string, unknown>): RuntimeRequestIds {
  const runId = optionalString(payload.runId);
  const messageId = optionalString(payload.messageId);
  return { runId, messageId };
}

function normalizeRequestIds(ids: RuntimeRequestIds | undefined): Required<RuntimeRequestIds> {
  return {
    runId: ids?.runId ?? randomUUID(),
    messageId: ids?.messageId ?? randomUUID()
  };
}

function readRunMode(value: unknown): AgentRunMode {
  if (value === "chat" || value === "plan") return value;
  throw new Error("Runtime Host run mode must be chat or plan.");
}

function readPermissionMode(value: unknown): PermissionMode {
  if (value === "ask" || value === "read-only" || value === "auto" || value === "full-access") return value;
  throw new Error("Runtime Host permission mode is invalid.");
}

function readPermissionResult(value: unknown): PermissionResult {
  const record = asRecord(value);
  if (typeof record.approved !== "boolean") throw new Error("Runtime Host permission result is invalid.");
  return {
    approved: record.approved,
    scope: record.scope as PermissionResult["scope"],
    nextMode: record.nextMode as PermissionResult["nextMode"],
    message: optionalString(record.message),
    confirmation: optionalString(record.confirmation)
  };
}

function readThinking(value: unknown): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const parsed = thinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error("Runtime Host thinking selection is invalid.");
  return parsed.data;
}

function readSurface(value: unknown): HostSurface {
  if (isSurface(value)) return value;
  throw new Error("Runtime Host surface is invalid.");
}

function isSurface(value: unknown): value is HostSurface {
  return value === "desktop" || value === "tui" || value === "cli";
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function readRegistration(paths: RuntimeHostPaths): Promise<HostRegistration | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.registrationPath, "utf8")) as unknown;
    const registration = asRecord(parsed);
    if (
      registration.protocolVersion !== protocolVersion
      || registration.endpoint !== paths.endpoint
      || registration.rootHash !== paths.rootHash
      || typeof registration.token !== "string"
      || typeof registration.hostEpoch !== "string"
      || typeof registration.persistenceRoot !== "string"
      || !Number.isSafeInteger(registration.pid)
    ) return undefined;
    return {
      protocolVersion,
      endpoint: paths.endpoint,
      registrationPath: paths.registrationPath,
      lockPath: paths.lockPath,
      rootHash: paths.rootHash,
      persistenceRoot: registration.persistenceRoot,
      hostEpoch: registration.hostEpoch,
      token: registration.token,
      pid: registration.pid as number,
      createdAt: typeof registration.createdAt === "string" ? registration.createdAt : ""
    };
  } catch {
    return undefined;
  }
}

async function writeRegistration(registration: HostRegistration): Promise<void> {
  await fs.writeFile(registration.registrationPath, `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  await fs.chmod(registration.registrationPath, 0o600);
}

async function acquireHostLock(paths: RuntimeHostPaths, persistenceRoot: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fs.open(paths.lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const registration = await readRegistration(paths);
      if (registration && isProcessAlive(registration.pid)) {
        throw new Error(`Runtime Host is already running for ${path.resolve(persistenceRoot)}.`);
      }
      await removeStaleRegistration(registration ?? {
        protocolVersion,
        endpoint: paths.endpoint,
        registrationPath: paths.registrationPath,
        lockPath: paths.lockPath,
        rootHash: paths.rootHash,
        persistenceRoot: path.resolve(persistenceRoot),
        hostEpoch: "",
        token: "",
        pid: 0,
        createdAt: ""
      });
    }
  }
  throw new Error("Unable to acquire Runtime Host lock.");
}

async function removeStaleRegistration(registration: HostRegistration): Promise<void> {
  await fs.rm(registration.registrationPath, { force: true });
  await removeSocketIfStale(registration.endpoint);
  await fs.rm(registration.lockPath, { force: true });
}

async function removeRegistration(registration: HostRegistration): Promise<void> {
  const current = await readRegistration({
    endpoint: registration.endpoint,
    registrationPath: registration.registrationPath,
    lockPath: registration.lockPath,
    rootHash: registration.rootHash
  });
  if (current?.hostEpoch === registration.hostEpoch) await fs.rm(registration.registrationPath, { force: true });
  await removeSocketIfStale(registration.endpoint);
  await fs.rm(registration.lockPath, { force: true });
}

async function removeSocketIfStale(endpoint: string): Promise<void> {
  try {
    await fs.rm(endpoint, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isConnectionRefused(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ESRCH";
}

function isRuntimeHostThinkingSelectionError(error: unknown): boolean {
  return error instanceof Error && error.message === "Runtime Host thinking selection is invalid.";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
