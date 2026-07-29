import type { Checkpoint, RestoreSummary } from "../session/checkpointStore.js";
import type { InterruptedTurn } from "../session/turnStore.js";
import type { ForkedSession } from "../session/fork.js";
import { randomUUID } from "node:crypto";
import type { AgentAttachment, AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { AgentPermissionResult, AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import type { ContextStatus, MemoryCompactionTopicResult, MemoryEntrySummary, MemoryMatch } from "../agent/context/types.js";
import type { LocalMemory, MemoryWriteResult } from "../agent/context/LocalMemory.js";
import type { ExtensionSection } from "../extensions/report.js";
import type { SubagentDefinition } from "../extensions/agents.js";
import type { McpServerStatus } from "../extensions/mcp.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionSummary } from "../session/events.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
import {
  type SubagentTaskRunOptions,
  type SubagentTaskSnapshot,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { RootRunScheduler } from "./RootRunScheduler.js";
import { resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import { SessionLeaseStore, type SessionLease } from "./SessionLease.js";
import type {
  ActiveRunSnapshot,
  AgentHostEvent,
  AgentPermissionEventRequest,
  AgentRuntimeUpdate,
  InteractiveRunState,
  InteractiveRuntimeSnapshot,
  PendingPermissionSnapshot,
  RuntimeOperation
} from "./agentEvents.js";
import { reduceInteractiveRunState } from "./agentEvents.js";

type ExclusiveRuntimeOperation = RuntimeOperation;

export interface SubmittedAgentRun {
  runId: string;
  messageId: string;
  queued: boolean;
  completion: Promise<AgentRunOutcome>;
}

export interface AgentRunOutcome extends AgentTurnOutcome {
  runId: string;
  durationMs: number;
}

export interface InteractiveAgentRuntimeOptions {
  shutdownDrainMs?: number;
  maxQueuedRuns?: number;
  /** 由 composition root 注入；测试可省略跨进程租约。 */
  sessionLeases?: SessionLeaseStore;
  /** 仅 `biny run` 注入；普通 Chat/Plan 运行时不依赖自主执行模块。 */
  autonomousExecutor?: AutonomousExecutor;
}

export interface AutonomousExecutor {
  execute(options: {
    runId: string;
    sessionId: string;
    input: string;
    mode: "autonomous";
    attachments: AgentAttachment[];
    signal: AbortSignal;
    confirmPermission(request: AgentPermissionEventRequest): Promise<AgentPermissionResult>;
    onAgentEvent(event: AgentSessionEvent): boolean;
    onReasoningCompleted(): void;
  }): Promise<{ turn: AgentTurnOutcome }>;
}

interface QueuedAgentRun extends ActiveRunSnapshot {
  queuedAtMs: number;
  wasQueued: boolean;
  continuation: boolean;
  attachments: AgentAttachment[];
}

interface PendingPermission extends PendingPermissionSnapshot {
  resolve(result: AgentPermissionResult): void;
}

interface ActiveTool {
  tool: string;
  args: unknown;
  display?: ToolInputDisplay;
  startedAtMs: number;
  commandStarted: boolean;
}

interface SessionLeaseState {
  lease: SessionLease | undefined;
  acquired: boolean;
}

/**
 * UI-independent interactive host for AgentSession. It owns run queuing,
 * permission waits and AbortController state while AgentSession continues to
 * own model context, tools and JSONL persistence.
 */
export class InteractiveAgentRuntime {
  private static readonly maxQueuedRuns = 32;
  private static readonly defaultShutdownDrainMs = 2_000;
  private readonly events = new AgentEventBus<AgentHostEvent>();
  private readonly updates = new AgentEventBus<AgentRuntimeUpdate>();
  private readonly rootRunScheduler: RootRunScheduler<QueuedAgentRun, AgentRunOutcome>;
  private readonly sessionLeases: SessionLeaseStore | undefined;
  private readonly autonomousExecutor: AutonomousExecutor | undefined;
  private sessionLease: SessionLease | undefined;
  private state: InteractiveRunState = { kind: "idle" };
  private revision = 0;
  private readonly tools = new Map<string, ActiveTool>();
  private readonly permissionRequestIds = new Map<string, string>();
  private pendingPermission: PendingPermission | undefined;
  private abortController: AbortController | undefined;
  private activeOperationCompletion: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private commandRuntimeClosePromise: Promise<void> | undefined;
  private closed = false;
  private readonly shutdownDrainMs: number;

  constructor(
    private readonly commandRuntime: CommandRuntime,
    options: InteractiveAgentRuntimeOptions = {}
  ) {
    this.shutdownDrainMs = options.shutdownDrainMs ?? InteractiveAgentRuntime.defaultShutdownDrainMs;
    if (!Number.isSafeInteger(this.shutdownDrainMs) || this.shutdownDrainMs < 0) {
      throw new Error("shutdownDrainMs must be a non-negative safe integer.");
    }
    this.sessionLeases = options.sessionLeases;
    this.autonomousExecutor = options.autonomousExecutor;
    this.events.subscribe((event) => {
      this.state = reduceInteractiveRunState(this.state, event);
      this.revision += 1;
      this.updates.emit({ event, snapshot: this.getSnapshot() });
    });
    this.rootRunScheduler = new RootRunScheduler({
      maxQueuedRuns: options.maxQueuedRuns ?? InteractiveAgentRuntime.maxQueuedRuns,
      execute: async (run, signal) => await this.executeRun(run, signal),
      onQueuedCancellation: (run, reason) => this.abortQueuedRun(run, reason),
      onExecutionFailure: (run, error) => this.failScheduledRun(run, error)
    });
  }

  getInfo(): AgentSessionInfo {
    return this.commandRuntime.agent.getInfo();
  }

  getPermissionMode(): PermissionMode {
    return this.commandRuntime.agent.getPermissionMode();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.runMaintenanceOperation("permission", async () => await this.commandRuntime.agent.setPermissionMode(mode));
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    return await this.runMaintenanceOperation("permission", async () => await this.commandRuntime.agent.runPermissionCommand(args));
  }

  listModels(): ModelChoice[] {
    return this.commandRuntime.agent.listModels();
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    return await this.runMaintenanceOperation("switch_model", async () => await this.commandRuntime.agent.switchModel(alias, thinking));
  }

  async refreshModelFromDisk(): Promise<ModelRuntimeInfo> {
    return await this.runMaintenanceOperation("refresh_model", async () => await this.commandRuntime.agent.refreshModelFromDisk());
  }

  async refreshModelCatalog(providerAlias?: string): Promise<ModelChoice[]> {
    return await this.runMaintenanceOperation("model_catalog", async () => await this.commandRuntime.agent.refreshModelCatalog(providerAlias));
  }

  submitPrompt(input: string, mode: AgentRunMode = "chat", attachments: AgentAttachment[] = []): SubmittedAgentRun {
    return this.enqueueRun(input, mode, attachments, false);
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    if (this.state.kind !== "idle") {
      throw new Error("Cannot continue an interrupted turn while the runtime is busy.");
    }
    const interrupted = await this.commandRuntime.interruptedTurn();
    if (!interrupted) return undefined;
    return await this.enqueueRun(interrupted.prompt, "chat", [], true).completion;
  }

  private enqueueRun(
    input: string,
    mode: AgentRunMode,
    attachments: AgentAttachment[],
    continuation: boolean
  ): SubmittedAgentRun {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind === "maintenance") {
      throw new Error(`Cannot submit a prompt while ${publicOperationName(this.state.operation)} is running.`);
    }
    if (this.state.kind === "background_subagent") {
      throw new Error("Cannot submit a prompt while a subagent task is running for this session.");
    }
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    // 能力校验交给 AgentSession。它会先把输入和附件引用写入 JSONL，再返回明确的
    // vision/audio 错误，避免用户粘贴的内容在失败时从会话历史里消失。
    const sessionId = this.getInfo().sessionId;
    this.acquireSessionLease(sessionId);
    const runId = randomUUID();
    const messageId = randomUUID();
    const queuedAtMs = Date.now();
    const run: QueuedAgentRun = {
      sessionId,
      runId,
      messageId,
      input,
      mode,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      status: "queued",
      startedAt: new Date(queuedAtMs).toISOString(),
      queuedAtMs,
      wasQueued: this.rootRunScheduler.activeRun !== undefined || this.rootRunScheduler.queueLength > 0,
      continuation
    };
    try {
      const submitted = this.rootRunScheduler.submit(run);
      if (submitted.queued) {
        this.events.emit({
          ...this.eventBase(run),
          type: "run.queued",
          messageId: run.messageId,
          input: run.input,
          mode: "autonomous",
          position: this.rootRunScheduler.queueLength,
          queueLength: this.rootRunScheduler.queueLength
        });
      }
      const releaseWhenIdle = (): void => {
        this.releaseSessionLeaseIfIdle();
      };
      void submitted.completion.then(releaseWhenIdle, releaseWhenIdle);
      return { runId, messageId, queued: submitted.queued, completion: submitted.completion };
    } catch (error) {
      this.releaseSessionLeaseIfIdle();
      throw error;
    }
  }

  cancelCurrentRun(): void {
    const activeRun = this.rootRunScheduler.activeRun;
    if (activeRun) this.cancelRun(activeRun.runId);
    else if (this.state.kind === "maintenance") this.abortController?.abort();
    for (const queued of this.rootRunScheduler.queuedRuns) this.cancelRun(queued.runId);
  }

  async waitForIdle(): Promise<void> {
    try {
      while (this.rootRunScheduler.activeRun || this.rootRunScheduler.queueLength || this.state.kind === "maintenance") {
        if (this.rootRunScheduler.activeRun || this.rootRunScheduler.queueLength) {
          await this.rootRunScheduler.waitForIdle();
        } else if (this.activeOperationCompletion) {
          await this.activeOperationCompletion;
        } else {
          await new Promise<void>((resolve) => queueMicrotask(resolve));
        }
      }
    } finally {
      this.releaseSessionLeaseIfIdle();
    }
  }

  cancelRun(runId: string): boolean {
    const active = this.rootRunScheduler.activeRun;
    if (active?.runId === runId) {
      this.commandRuntime.cancelSubagentTasks(active.runId, "Current turn interrupted.");
      this.pendingPermission?.resolve({ approved: false, scope: "once", message: "Current turn interrupted." });
      this.pendingPermission = undefined;
      return this.rootRunScheduler.cancel(runId);
    }
    const queued = this.rootRunScheduler.queuedRuns.find((run) => run.runId === runId);
    const cancelled = this.rootRunScheduler.cancel(runId, "Cancelled before execution.");
    if (cancelled && queued) {
      this.events.emit({
        ...this.eventBase(queued),
        type: "run.queue.updated",
        queueLength: this.rootRunScheduler.queueLength
      });
    }
    return cancelled;
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingPermission;
    if (!pending || pending.requestId !== requestId) throw new Error("Permission request is no longer pending.");
    if (result.approved && pending.request.requireFullYes && !isFullYesConfirmation(result.confirmation ?? "")) {
      throw new Error("This operation requires the full word yes before it can be approved.");
    }
    pending.resolve({
      approved: result.approved,
      scope: result.scope,
      nextMode: result.nextMode,
      message: result.message,
      confirmation: result.confirmation
    });
    this.pendingPermission = undefined;
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    const filePath = await resolveSessionFile(this.commandRuntime.persistenceRoot, session);
    const sessionId = sessionIdFromFile(filePath);
    return await this.runMaintenanceOperation("resume", async () => await this.commandRuntime.agent.resume(session), undefined, sessionId);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.commandRuntime.agent.listSessions();
  }

  async forkSession(session: string | undefined, upToEvent?: number): Promise<ForkedSession> {
    return await this.commandRuntime.forkSession(session, upToEvent);
  }

  async interruptedTurn(): Promise<InterruptedTurn | undefined> {
    return await this.commandRuntime.interruptedTurn();
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    return await this.commandRuntime.listCheckpoints();
  }

  async restoreCheckpoint(id: string): Promise<RestoreSummary> {
    return await this.commandRuntime.restoreCheckpoint(id);
  }

  extensionReport(section?: ExtensionSection): string {
    return this.commandRuntime.extensionReport(section);
  }

  async runMemoryCommand(args: string[]): Promise<string> {
    // add/forget 会改写 .biny/memory，与活动回合的自动记忆写入互斥，走维护操作队列。
    return await this.runMaintenanceOperation("memory", async () => await this.commandRuntime.agent.runMemoryCommand(args));
  }

  /** 以下记忆面板操作与 runMemoryCommand 同队列：读写都不与活动回合的自动记忆写入并发。 */
  async listMemoryEntries(): Promise<MemoryEntrySummary[]> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().listEntries());
  }

  async searchMemory(query: string): Promise<MemoryMatch[]> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().findRelevant(query, [], 8));
  }

  async addMemoryEntry(topic: string, note: string): Promise<MemoryWriteResult> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().write({
      topic,
      title: note.split("\n", 1)[0]?.slice(0, 120) ?? "Project note",
      summary: note,
      decisions: [],
      paths: [],
      keywords: []
    }));
  }

  async deleteMemoryEntry(topic: string, index: number): Promise<boolean> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().deleteEntry(topic, index));
  }

  async forgetMemoryTopic(topic: string): Promise<boolean> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().forgetTopic(topic));
  }

  /** 清空全部话题，返回清掉的话题数。 */
  async clearMemory(): Promise<number> {
    return await this.runMaintenanceOperation("memory", async () => {
      const memory = this.requireLocalMemory();
      let removed = 0;
      for (const topic of await memory.listTopics()) {
        if (await memory.forgetTopic(topic)) removed += 1;
      }
      return removed;
    });
  }

  async compactMemory(topic?: string): Promise<MemoryCompactionTopicResult[]> {
    return await this.runMaintenanceOperation("memory", async () => await this.requireLocalMemory().compactTopics(topic ? [topic] : undefined));
  }

  private requireLocalMemory(): LocalMemory {
    const memory = this.commandRuntime.agent.getLocalMemory();
    if (!memory) throw new Error("Local memory is disabled (context.memory.enabled = false).");
    return memory;
  }

  async listSubagentAgents(): Promise<SubagentDefinition[]> {
    return await this.commandRuntime.listSubagentAgents();
  }

  async reconnectMcpServer(serverName: string): Promise<McpServerStatus> {
    return await this.runMaintenanceOperation("mcp", async () => await this.commandRuntime.reconnectMcpServer(serverName));
  }

  listSubagentTasks(): SubagentTaskSnapshot[] {
    return this.commandRuntime.listSubagentTasks();
  }

  cancelSubagentTask(taskId: string, reason?: string): boolean {
    return this.commandRuntime.cancelSubagentTask(taskId, reason);
  }

  subscribeSubagentTasks(listener: (task: SubagentTaskSnapshot) => void): () => void {
    return this.commandRuntime.subscribeSubagentTasks(listener);
  }

  async runSubagentTask(task: string): Promise<string> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      "subagent",
      async () => {
        try {
          return await this.commandRuntime.runSubagentTask(task, {
            taskId: randomUUID(),
            signal: controller.signal
          });
        } catch (error) {
          if (!(error instanceof Error)) throw new Error(redactSecrets(String(error)));
          const publicMessage = redactSecrets(error.message);
          if (publicMessage === error.message) throw error;
          try {
            Object.defineProperty(error, "message", { value: publicMessage, configurable: true });
          } catch {
            const publicError = new Error(publicMessage);
            publicError.name = error.name;
            throw publicError;
          }
          throw error;
        }
      },
      controller
    );
  }

  startSubagentTask(task: string, options?: SubagentTaskRunOptions): SubmittedSubagentTask {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle") {
      throw new Error("Cannot start a background subagent while the runtime is busy.");
    }
    const leaseState = this.acquireSessionLease(this.getInfo().sessionId);
    this.setState({ kind: "background_subagent", count: 1 });
    try {
      const submitted = this.commandRuntime.startSubagentTask(task, options);
      const release = (): void => {
        this.setState({ kind: "idle" });
        this.releaseSessionLeaseIfIdle();
      };
      void submitted.completion.then(release, release);
      return submitted;
    } catch (error) {
      this.setState({ kind: "idle" });
      this.releaseSessionLease(leaseState);
      throw error;
    }
  }

  async contextReport(): Promise<string> {
    return await this.commandRuntime.agent.contextReport();
  }

  usageReport(): string {
    return this.commandRuntime.agent.usageReport();
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.commandRuntime.agent.contextStatus();
  }

  async compactConversation(hint?: string): Promise<string> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      "compact",
      async () => {
        const info = this.getInfo();
        const runId = randomUUID();
        const run = this.standaloneRun(info.sessionId, runId, hint ?? "Compact conversation");
        this.events.emit({
          ...this.eventBase(run),
          type: "compact.started",
          hint: hint === undefined ? undefined : redactSecrets(hint)
        });
        const rawSummary = await this.commandRuntime.agent.compactConversation(hint, controller.signal);
        const summary = redactSecrets(rawSummary);
        const context = await this.commandRuntime.agent.contextStatus();
        this.events.emit({ ...this.eventBase(run), type: "compact.completed", summary, context });
        return summary;
      },
      controller
    );
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    return {
      revision: this.revision,
      info: this.getInfo(),
      permissionMode: this.getPermissionMode(),
      state: cloneRunState(this.state)
    };
  }

  subscribe(listener: (event: AgentHostEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  subscribeUpdates(listener: (update: AgentRuntimeUpdate) => void): () => void {
    return this.updates.subscribe(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelCurrentRun();
    this.rootRunScheduler.close();
    this.closePromise = (async () => {
      const activeWriters = Promise.all([
        this.rootRunScheduler.waitForIdle(),
        this.activeOperationCompletion
      ]).then(() => undefined, () => undefined);
      if (await settlesWithin(activeWriters, this.shutdownDrainMs)) {
        await this.closeCommandRuntime();
        return;
      }

      // A provider or maintenance implementation may ignore AbortSignal. Keep
      // the recorder open until that writer really settles, while allowing the
      // UI host itself to close within a bounded time.
      void activeWriters
        .then(async () => await this.closeCommandRuntime())
        .catch(() => undefined);
    })();
    return this.closePromise;
  }

  private closeCommandRuntime(): Promise<void> {
    this.commandRuntimeClosePromise ??= Promise.resolve().then(async () => {
      try {
        await this.commandRuntime.close();
      } finally {
        this.sessionLease?.close();
        this.sessionLease = undefined;
        this.sessionLeases?.close();
      }
    });
    return this.commandRuntimeClosePromise;
  }

  private async runMaintenanceOperation<T>(
    operation: ExclusiveRuntimeOperation,
    execute: () => Promise<T>,
    operationAbortController?: AbortController,
    sessionId = this.getInfo().sessionId
  ): Promise<T> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle") {
      throw new Error(`Cannot start ${publicOperationName(operation)} while the runtime is busy.`);
    }
    const leaseState = this.acquireSessionLease(sessionId);
    this.setState({ kind: "maintenance", operation });
    if (operationAbortController) this.abortController = operationAbortController;
    const execution = Promise.resolve().then(execute);
    const completion = execution.then(() => undefined, () => undefined);
    this.activeOperationCompletion = completion;
    try {
      return await execution;
    } finally {
      if (operationAbortController && this.abortController === operationAbortController) {
        this.abortController = undefined;
      }
      if (this.activeOperationCompletion === completion) {
        this.activeOperationCompletion = undefined;
        this.setState({ kind: "idle" });
      }
      this.releaseSessionLease(leaseState);
    }
  }

  private acquireSessionLease(sessionId: string): SessionLeaseState {
    const current = this.sessionLease;
    if (current?.sessionId === sessionId) return { lease: current, acquired: false };
    current?.close();
    this.sessionLease = undefined;
    if (!this.sessionLeases) return { lease: undefined, acquired: false };
    const lease = this.sessionLeases.acquire(sessionId);
    this.sessionLease = lease;
    return { lease, acquired: true };
  }

  private releaseSessionLease(state: SessionLeaseState): void {
    if (!state.acquired || !state.lease || this.sessionLease !== state.lease) return;
    state.lease.close();
    this.sessionLease = undefined;
  }

  private releaseSessionLeaseIfIdle(): void {
    if (this.state.kind !== "idle") return;
    const lease = this.sessionLease;
    if (!lease) return;
    lease.close();
    this.sessionLease = undefined;
  }

  private abortQueuedRun(run: QueuedAgentRun, reason: string): AgentRunOutcome {
    run.status = "aborted";
    const publicReason = redactSecrets(reason);
    this.events.emit({ ...this.eventBase(run), type: "run.aborted", durationMs: 0, reason: publicReason });
    return {
      runId: run.runId,
      status: "aborted",
      stopReason: "aborted",
      steps: 0,
      output: "",
      durationMs: 0,
      error: publicReason
    };
  }

  private failScheduledRun(run: QueuedAgentRun, error: unknown): AgentRunOutcome {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const durationMs = Math.max(0, Date.now() - run.queuedAtMs);
    run.status = "failed";
    this.events.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: message });
    return {
      runId: run.runId,
      status: "failed",
      stopReason: "provider_error",
      steps: 0,
      output: "",
      durationMs,
      error: message
    };
  }

  private async executeRun(run: QueuedAgentRun, signal: AbortSignal): Promise<AgentRunOutcome> {
    const agent = this.commandRuntime.agent;
    const startedAtMs = Date.now();
    const info = agent.getInfo();
    run.sessionId = info.sessionId;
    run.status = "thinking";
    run.startedAt = new Date(startedAtMs).toISOString();
    if (run.wasQueued) {
      this.events.emit({
        ...this.eventBase(run),
        type: "run.queue.updated",
        queueLength: this.rootRunScheduler.queueLength
      });
    }
    this.commandRuntime.setSubagentParentRunId(run.runId);
    this.tools.clear();
    this.permissionRequestIds.clear();
    if (!run.continuation) {
      this.events.emit({
        ...this.eventBase(run),
        type: "message.user",
        messageId: run.messageId,
        content: run.input
      });
    }
    this.events.emit({
      ...this.eventBase(run),
      type: "run.started",
      messageId: run.messageId,
      input: run.input,
      mode: run.mode,
      model: {
        alias: info.modelAlias,
        provider: info.provider,
        label: info.modelLabel,
        reasoning: info.reasoningLabel
      },
      skills: info.skills ?? []
    });

    try {
      let reasoningActive = false;
      let turn: AgentTurnOutcome | undefined;
      if (run.mode === "autonomous") {
        if (!this.autonomousExecutor) {
          throw new Error("Autonomous execution is available only through `biny run`.");
        }
        ({ turn } = await this.autonomousExecutor.execute({
          runId: run.runId,
          sessionId: run.sessionId,
          input: run.input,
          mode: run.mode,
          attachments: run.attachments,
          signal,
          confirmPermission: async (request) => await this.waitForPermission(run, request),
          onAgentEvent: (event) => {
            const mapped = this.handleAgentEvent(run, event, reasoningActive);
            return reasoningActive = mapped.reasoningActive;
          },
          onReasoningCompleted: () => {
            this.events.emit({
              ...this.eventBase(run),
              type: "reasoning.completed",
              messageId: run.messageId,
              status: "分析完成"
            });
          }
        }));
      } else {
        // Chat/Plan 与 pi 一样只驱动一个 AgentSession 回合；不创建任务契约，也不在回答后
        // 擅自跑验收命令。Plan 的只读工具限制仍由 AgentSession/Sdk coordinator 负责。
        let terminalEvents = 0;
        let streamFailure: string | undefined;
        const runOptions = {
          abortSignal: signal,
          confirmPermission: async (request: AgentPermissionEventRequest) => await this.waitForPermission(run, request),
          mode: run.mode,
          attachments: run.attachments
        };
        const stream = run.continuation
          ? agent.continueInterruptedTurn(runOptions)
          : agent.run(run.input, runOptions);
        for await (const event of stream) {
          const mapped = this.handleAgentEvent(run, event, reasoningActive);
          reasoningActive = mapped.reasoningActive;
          streamFailure ??= mapped.failure;
          if (event.type === "done") {
            terminalEvents += 1;
            turn = event.outcome;
          }
        }
        if (reasoningActive) {
          this.events.emit({
            ...this.eventBase(run),
            type: "reasoning.completed",
            messageId: run.messageId,
            status: "分析完成"
          });
        }
        // 非协作嵌入方可能在 AbortSignal 后仍吐出一个“完成”事件；取消优先，不能把晚到的
        // 结果写成成功回合。
        if (signal.aborted) throw new Error("Current turn interrupted.");
        if (terminalEvents !== 1 || !turn) {
          throw new Error(terminalEvents > 1
            ? "Agent stream emitted multiple terminal results."
            : streamFailure ?? "Agent stream ended without a terminal result.");
        }
      }
      const durationMs = Date.now() - startedAtMs;
      if (turn.output && (turn.status === "completed" || turn.status === "incomplete")) {
        this.emitAssistantCompleted(run, turn.output);
      }
      const context = await agent.contextStatus();
      this.events.emit({ ...this.eventBase(run), type: "context.updated", context });
      if (turn.status === "completed") {
        const outcome = this.completeRun(run, durationMs, turn);
        // autonomous 的 attempt 会延迟记忆到独立验收通过；直接 chat/plan 已由 AgentSession 在
        // 写入 assistant 消息后处理，不能重复入库。
        if (run.mode === "autonomous" && outcome.status === "completed") agent.rememberSuccessfulTask?.(run.input, turn.output);
        return outcome;
      }
      if (turn.status === "incomplete") return this.incompleteRun(run, durationMs, turn);
      if (turn.status === "aborted") return this.abortRun(run, durationMs, turn.error ?? "Current turn interrupted.", turn);
      return this.failRun(run, durationMs, turn.error ?? "Task verification failed.", turn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;
      if (signal.aborted) {
        const reason = "Current turn interrupted.";
        return this.abortRun(run, durationMs, reason);
      }
      agent.recordError(error);
      return this.failRun(run, durationMs, message);
    } finally {
      this.pendingPermission = undefined;
      this.commandRuntime.setSubagentParentRunId(undefined);
      this.tools.clear();
      this.permissionRequestIds.clear();
    }
  }

  private emitAssistantCompleted(run: ActiveRunSnapshot, content: string): void {
    this.events.emit({
      ...this.eventBase(run),
      type: "assistant.completed",
      messageId: run.messageId,
      content: redactSecrets(content)
    });
  }

  private completeRun(run: ActiveRunSnapshot, durationMs: number, turn: AgentTurnOutcome): AgentRunOutcome {
    run.status = "completed";
    this.events.emit({
      ...this.eventBase(run),
      type: "run.completed",
      durationMs,
      stopReason: "model_stop",
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return { runId: run.runId, durationMs, ...turn };
  }

  private incompleteRun(run: ActiveRunSnapshot, durationMs: number, turn: AgentTurnOutcome): AgentRunOutcome {
    const reason = turn.error ?? incompleteReason(turn);
    run.status = "incomplete";
    this.events.emit({
      ...this.eventBase(run),
      type: "run.incomplete",
      durationMs,
      reason: redactSecrets(reason),
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return { runId: run.runId, durationMs, ...turn, error: turn.error ?? redactSecrets(reason) };
  }

  private abortRun(
    run: ActiveRunSnapshot,
    durationMs: number,
    reason: string,
    turn?: AgentTurnOutcome
  ): AgentRunOutcome {
    const publicReason = redactSecrets(reason);
    run.status = "aborted";
    this.events.emit({
      ...this.eventBase(run),
      type: "run.aborted",
      durationMs,
      reason: publicReason,
      stopReason: turn?.stopReason ?? "aborted",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0
    });
    return {
      runId: run.runId,
      status: "aborted",
      stopReason: "aborted",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      error: publicReason
    };
  }

  private failRun(
    run: ActiveRunSnapshot,
    durationMs: number,
    error: string,
    turn?: AgentTurnOutcome
  ): AgentRunOutcome {
    const publicError = redactSecrets(error);
    run.status = "failed";
    this.events.emit({
      ...this.eventBase(run),
      type: "run.failed",
      durationMs,
      error: publicError,
      stopReason: turn?.stopReason ?? "provider_error",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0
    });
    return {
      runId: run.runId,
      status: "failed",
      stopReason: turn?.stopReason ?? "provider_error",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      error: publicError
    };
  }

  private handleAgentEvent(
    run: ActiveRunSnapshot,
    event: AgentSessionEvent,
    reasoningActive: boolean
  ): { reasoningActive: boolean; failure?: string } {
    if (event.type === "status") {
      run.status = event.status === "waiting_permission"
        ? "waiting_permission"
        : event.status === "running"
          ? "running"
          : event.status === "error"
            ? "failed"
            : event.status;
      if (event.status === "thinking" && !reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.started", messageId: run.messageId, status: "正在分析任务" });
        return { reasoningActive: true };
      }
      return { reasoningActive, failure: event.status === "error" ? "Agent run failed." : undefined };
    }

    if (event.type === "sdk") {
      const part = event.part;
      if (part.type === "start-step" && !reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.started", messageId: run.messageId, status: "正在继续处理" });
        return { reasoningActive: true };
      }
      if (part.type === "reasoning-delta") {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.delta", messageId: run.messageId, content: redactSecrets(part.text) });
        return { reasoningActive: true };
      }
      if (part.type === "text-delta") {
        if (reasoningActive) {
          this.events.emit({ ...this.eventBase(run), type: "reasoning.completed", messageId: run.messageId, status: "分析完成" });
        }
        this.events.emit({ ...this.eventBase(run), type: "assistant.delta", messageId: run.messageId, content: redactSecrets(part.text) });
        return { reasoningActive: false };
      }
      if (part.type === "tool-result") {
        this.completeTool(run, part.toolCallId, part.toolName, part.output);
        return { reasoningActive };
      }
      if (part.type === "tool-error") {
        this.failTool(run, part.toolCallId, part.toolName, String(part.error));
        return { reasoningActive };
      }
      return { reasoningActive };
    }

    if (event.type === "tool-started") {
      if (reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.completed", messageId: run.messageId, status: "分析完成" });
      }
      run.status = "running";
      const args = redactSensitiveValue(event.args);
      const display = redactToolDisplay(event.display);
      this.tools.set(event.toolCallId, {
        tool: event.tool,
        args,
        display,
        startedAtMs: Date.now(),
        commandStarted: false
      });
      this.events.emit({
        ...this.eventBase(run),
        type: "tool.started",
        toolCallId: event.toolCallId,
        tool: event.tool,
        args,
        description: event.description === undefined ? undefined : redactSecrets(event.description),
        display
      });
      this.events.emit({
        ...this.eventBase(run),
        type: "reasoning.status",
        messageId: run.messageId,
        status: publicToolStatus(event.tool, display)
      });
      return { reasoningActive: false };
    }

    if (event.type === "tool-progress") {
      const update = redactSensitiveValue(event.update) as typeof event.update;
      this.events.emit({ ...this.eventBase(run), type: "tool.progress", toolCallId: event.toolCallId, tool: event.tool, update });
      const activeTool = this.tools.get(event.toolCallId);
      if (activeTool?.display?.kind === "command" && update.text) {
        this.startCommandIfNeeded(run, event.toolCallId, activeTool);
        const stream = update.kind === "stdout" || update.kind === "stderr" ? update.kind : "status";
        this.events.emit({ ...this.eventBase(run), type: "command.output", toolCallId: event.toolCallId, stream, content: update.text });
      }
      return { reasoningActive };
    }

    if (event.type === "permission-requested") {
      run.status = "waiting_permission";
      return { reasoningActive };
    }

    if (event.type === "permission-result") {
      run.status = "running";
      const requestId = this.permissionRequestIds.get(event.toolCallId) ?? randomUUID();
      this.events.emit({
        ...this.eventBase(run),
        type: "permission.resolved",
        requestId,
        toolCallId: event.toolCallId,
        tool: event.request.tool,
        approved: event.result.approved,
        scope: event.result.scope,
        message: event.result.message === undefined ? undefined : redactSecrets(event.result.message)
      });
      return { reasoningActive };
    }

    if (event.type === "error") {
      const fatal = (event as typeof event & { fatal?: boolean }).fatal;
      return { reasoningActive, failure: fatal === false ? undefined : event.message };
    }
    if (event.type === "done") {
      return { reasoningActive };
    }
    return { reasoningActive };
  }

  private async waitForPermission(run: ActiveRunSnapshot, request: AgentPermissionEventRequest): Promise<AgentPermissionResult> {
    const toolCallId = request.toolCallId;
    const requestId = randomUUID();
    const publicRequest = redactPermissionRequest(request);
    this.permissionRequestIds.set(toolCallId, requestId);
    const result = await new Promise<AgentPermissionResult>((resolve) => {
      this.pendingPermission = {
        sessionId: run.sessionId,
        runId: run.runId,
        requestId,
        toolCallId,
        request: publicRequest,
        resolve
      };
      this.events.emit({ ...this.eventBase(run), type: "permission.requested", requestId, toolCallId, request: publicRequest });
    });
    return result;
  }

  private completeTool(run: ActiveRunSnapshot, toolCallId: string, tool: string, result: unknown): void {
    if (isFailedResult(result)) {
      this.failTool(run, toolCallId, tool, toolFailureMessage(result), result);
      return;
    }
    const active = this.tools.get(toolCallId);
    const durationMs = readNumber(result, "durationMs") ?? (active ? Date.now() - active.startedAtMs : undefined);
    const publicResult = redactSensitiveValue(result);
    this.events.emit({ ...this.eventBase(run), type: "tool.completed", toolCallId, tool, result: publicResult, durationMs });
    const display = active?.display;
    if (display?.kind === "command") {
      if (active) this.startCommandIfNeeded(run, toolCallId, active);
      this.events.emit({
        ...this.eventBase(run),
        type: "command.completed",
        toolCallId,
        command: display.command,
        cwd: display.cwd,
        exitCode: readNumber(publicResult, "exitCode"),
        durationMs
      });
    }
    if (display?.kind === "file_io" && display.path) {
      if (display.operation === "read") {
        this.events.emit({ ...this.eventBase(run), type: "file.read", toolCallId, path: display.path, lineStart: undefined, lineEnd: undefined });
      } else if ((display.operation === "write" || display.operation === "edit") && !isFailedResult(result)) {
        this.events.emit({
          ...this.eventBase(run),
          type: "file.changed",
          toolCallId,
          path: display.path,
          operation: display.operation,
          summary: readString(publicResult, "changeSummary")
        });
      }
    }
    const diff = tool === "git_diff" ? readString(publicResult, "output") : readString(publicResult, "diffPreview");
    if (diff) {
      this.events.emit({
        ...this.eventBase(run),
        type: "diff.created",
        toolCallId,
        diff,
        path: display?.kind === "file_io" ? display.path : undefined
      });
    }
    this.tools.delete(toolCallId);
  }

  private failTool(run: ActiveRunSnapshot, toolCallId: string, tool: string, error: string, result?: unknown): void {
    const active = this.tools.get(toolCallId);
    const durationMs = active ? Date.now() - active.startedAtMs : undefined;
    const publicError = redactSecrets(error);
    this.events.emit({ ...this.eventBase(run), type: "tool.failed", toolCallId, tool, error: publicError, durationMs });
    if (active?.display?.kind === "command") {
      this.startCommandIfNeeded(run, toolCallId, active);
      this.events.emit({
        ...this.eventBase(run),
        type: "command.failed",
        toolCallId,
        command: active.display.command,
        cwd: active.display.cwd,
        exitCode: readNumber(result, "exitCode"),
        status: readString(result, "status"),
        error: publicError,
        durationMs: readNumber(result, "durationMs") ?? durationMs
      });
    }
    this.tools.delete(toolCallId);
  }

  private startCommandIfNeeded(run: ActiveRunSnapshot, toolCallId: string, active: ActiveTool): void {
    if (active.commandStarted || active.display?.kind !== "command") return;
    active.commandStarted = true;
    this.events.emit({
      ...this.eventBase(run),
      type: "command.started",
      toolCallId,
      command: active.display.command,
      cwd: active.display.cwd
    });
  }

  private eventBase(run: Pick<ActiveRunSnapshot, "sessionId" | "runId">): Pick<AgentHostEvent, "sessionId" | "runId" | "timestamp"> {
    return { sessionId: run.sessionId, runId: run.runId, timestamp: new Date().toISOString() };
  }

  private standaloneRun(sessionId: string, runId: string, input: string): ActiveRunSnapshot {
    return {
      sessionId,
      runId,
      messageId: randomUUID(),
      input,
      mode: "chat",
      status: "running",
      startedAt: new Date().toISOString()
    };
  }

  private setState(state: InteractiveRunState): void {
    this.state = state;
    this.revision += 1;
    this.updates.emit({ snapshot: this.getSnapshot() });
  }
}

export async function createInteractiveAgentRuntime(workspaceRoot: string, options?: CommandRuntimeOptions): Promise<InteractiveAgentRuntime> {
  const sessionLeases = await SessionLeaseStore.open(options?.persistenceRoot ?? workspaceRoot);
  let commandRuntime: CommandRuntime | undefined;
  try {
    commandRuntime = await createCommandRuntime(workspaceRoot, options);
    return new InteractiveAgentRuntime(commandRuntime, { sessionLeases });
  } catch (error) {
    await commandRuntime?.close();
    sessionLeases.close();
    throw error;
  }
}

function cloneRunState(state: InteractiveRunState): InteractiveRunState {
  if (state.kind === "runs") {
    return {
      kind: "runs",
      activeRun: state.activeRun === undefined ? undefined : { ...state.activeRun },
      queuedRuns: state.queuedRuns.map((run) => ({ ...run })),
      pendingPermission: state.pendingPermission === undefined
        ? undefined
        : {
          ...state.pendingPermission,
          request: { ...state.pendingPermission.request }
        }
    };
  }
  return { ...state };
}

function redactPermissionRequest(request: AgentPermissionEventRequest): AgentPermissionEventRequest {
  return {
    ...request,
    command: request.command === undefined ? undefined : redactSecrets(request.command),
    reason: request.reason === undefined ? undefined : redactSecrets(request.reason),
    details: redactSecrets(request.details),
    diff: request.diff === undefined ? undefined : redactSecrets(request.diff),
    preview: request.preview === undefined ? undefined : redactSecrets(request.preview),
    changeSummary: request.changeSummary === undefined ? undefined : redactSecrets(request.changeSummary)
  };
}

function redactToolDisplay(display: ToolInputDisplay | undefined): ToolInputDisplay | undefined {
  if (display?.kind === "file_io") {
    return {
      ...display,
      content: display.content === undefined ? undefined : redactSecrets(display.content),
      before: display.before === undefined ? undefined : redactSecrets(display.before),
      after: display.after === undefined ? undefined : redactSecrets(display.after),
      detail: display.detail === undefined ? undefined : redactSecrets(display.detail)
    };
  }
  if (display?.kind === "command") {
    return {
      ...display,
      command: redactSecrets(display.command),
      description: display.description === undefined ? undefined : redactSecrets(display.description)
    };
  }
  if (display?.kind === "generic") {
    return {
      ...display,
      summary: redactSecrets(display.summary),
      detail: display.detail === undefined ? undefined : redactSensitiveValue(display.detail)
    };
  }
  return undefined;
}

function publicToolStatus(tool: string, display: ToolInputDisplay | undefined): string {
  if (display?.kind === "command") return "正在运行命令";
  if (display?.kind === "file_io") {
    if (display.operation === "read") return "正在读取文件";
    if (display.operation === "write" || display.operation === "edit") return "正在修改文件";
    if (display.operation === "search" || display.operation === "grep") return "正在搜索项目";
    if (display.operation === "git") return "正在检查 Git 状态";
  }
  return `正在执行 ${tool}`;
}

function publicOperationName(operation: ExclusiveRuntimeOperation): string {
  if (operation === "permission") return "a permission update";
  if (operation === "switch_model") return "model switching";
  if (operation === "refresh_model") return "model refresh";
  if (operation === "resume") return "session resume";
  if (operation === "compact") return "conversation compaction";
  if (operation === "mcp") return "MCP reconnection";
  if (operation === "memory") return "a memory command";
  return "a subagent task";
}

async function settlesWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function isFailedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.error === "string"
    || (typeof record.exitCode === "number" && record.exitCode !== 0)
    || record.approved === false
    || record.status === "denied"
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.status === "permission_required";
}

function toolFailureMessage(result: unknown): string {
  return readString(result, "error")
    ?? readString(result, "reason")
    ?? readString(result, "message")
    ?? (readNumber(result, "exitCode") !== undefined ? `Command exited with code ${String(readNumber(result, "exitCode"))}.` : undefined)
    ?? `Tool did not complete (${readString(result, "status") ?? "failed"}).`;
}

function incompleteReason(outcome: AgentTurnOutcome): string {
  if (outcome.stopReason === "step_limit") {
    return `Agent attempt reached its ${String(outcome.steps)}-step limit while the model still requested tools.`;
  }
  if (outcome.stopReason === "tool_pending") return "Agent attempt ended with pending tool work.";
  if (outcome.stopReason === "model_length") return "Agent attempt reached the model output limit before completion.";
  if (outcome.stopReason === "budget_exhausted") return "Task budget was exhausted before completion.";
  return `Agent attempt is incomplete (${outcome.stopReason}).`;
}
