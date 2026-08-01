import { randomUUID } from "node:crypto";
import type { AgentAttachment, AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { BlockedReason } from "../agent/completionGate.js";
import type { AgentPermissionResult, AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import type { PermissionResult } from "../permission/PermissionManager.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
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

export interface SubmittedAgentRun {
  runId: string;
  messageId: string;
  completion: Promise<AgentRunOutcome>;
}

export interface QueuedAgentMessage {
  runId: string;
  messageId: string;
  delivery: "steer" | "followUp";
}

export interface AgentRunOutcome extends AgentTurnOutcome {
  runId: string;
  durationMs: number;
}

export interface InteractiveAgentRuntimeOptions {
  shutdownDrainMs?: number;
  /** 由 composition root 注入；测试可省略跨进程租约。 */
  sessionLeases?: SessionLeaseStore;
}

export interface InteractiveAgentHost {
  runtime: InteractiveAgentRuntime;
  commands: CommandRuntime;
}

interface BackgroundOperation {
  completion: Promise<unknown>;
}

interface AgentRun extends ActiveRunSnapshot {
  startedAtMs: number;
  continuation: boolean;
  attachments: AgentAttachment[];
}

interface PendingPermission extends PendingPermissionSnapshot {
  resolve(result: AgentPermissionResult): void;
}

interface ActiveTool {
  startedAtMs: number;
}

interface SessionLeaseState {
  lease: SessionLease | undefined;
  acquired: boolean;
}

/**
 * UI-independent interactive host for AgentSession. It owns the active turn,
 * permission waits and AbortController state while AgentSession continues to
 * own model context, tools and JSONL persistence.
 */
export class InteractiveAgentRuntime {
  private static readonly defaultShutdownDrainMs = 2_000;
  private readonly updates = new AgentEventBus<AgentRuntimeUpdate>();
  private readonly sessionLeases: SessionLeaseStore | undefined;
  private sessionLease: SessionLease | undefined;
  private lastInfo: AgentSessionInfo | undefined;
  private state: InteractiveRunState = { kind: "idle" };
  private revision = 0;
  private readonly tools = new Map<string, ActiveTool>();
  private pendingPermission: PendingPermission | undefined;
  private activeRun: AgentRun | undefined;
  private activeRunController: AbortController | undefined;
  private activeRunCompletion: Promise<AgentRunOutcome> | undefined;
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
  }

  private getInfo(): AgentSessionInfo {
    const info = this.commandRuntime.agent.getInfo();
    this.lastInfo = info;
    return info;
  }

  submitPrompt(input: string, mode: AgentRunMode = "chat", attachments: AgentAttachment[] = []): SubmittedAgentRun {
    return this.startRun(input, mode, attachments, false);
  }

  steer(input: string, attachments: AgentAttachment[] = []): QueuedAgentMessage {
    return this.queueMessage(input, attachments, "steer");
  }

  followUp(input: string, attachments: AgentAttachment[] = []): QueuedAgentMessage {
    return this.queueMessage(input, attachments, "followUp");
  }

  private queueMessage(
    input: string,
    attachments: AgentAttachment[],
    delivery: "steer" | "followUp"
  ): QueuedAgentMessage {
    if (this.closed) throw new Error("Agent runtime is closed.");
    const run = this.activeRun;
    if (!run || this.state.kind !== "runs") throw new Error("There is no active run to receive a queued message.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
    const messageId = randomUUID();
    if (delivery === "steer") this.commandRuntime.agent.queueSteering(messageId, input, attachments);
    else this.commandRuntime.agent.queueFollowUp(messageId, input, attachments);
    return { runId: run.runId, messageId, delivery };
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error("Cannot continue an interrupted turn while the runtime is busy.");
    }
    const interrupted = await this.commandRuntime.agent.interruptedTurn();
    if (!interrupted) return undefined;
    return await this.startRun(interrupted.prompt, "chat", [], true).completion;
  }

  private startRun(
    input: string,
    mode: AgentRunMode,
    attachments: AgentAttachment[],
    continuation: boolean
  ): SubmittedAgentRun {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind === "maintenance") {
      throw new Error(`Cannot submit a prompt while ${publicOperationName(this.state.operation)} is running.`);
    }
    if (this.state.kind === "runs" || this.activeRun) {
      throw new Error("Cannot submit a prompt while the runtime is busy.");
    }
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    // 能力校验交给 AgentSession。它会先把输入和附件引用写入 JSONL，再返回明确的
    // vision/audio 错误，避免用户粘贴的内容在失败时从会话历史里消失。
    const sessionId = this.getInfo().sessionId;
    this.acquireSessionLease(sessionId);
    const runId = randomUUID();
    const messageId = randomUUID();
    const startedAtMs = Date.now();
    const run: AgentRun = {
      sessionId,
      runId,
      messageId,
      input,
      mode,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      status: "thinking",
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      continuation
    };
    const controller = new AbortController();
    this.activeRun = run;
    this.activeRunController = controller;
    const execution = this.executeRun(run, controller.signal);
    const completion = execution
      .catch((error: unknown) => this.failUncaughtRun(run, error))
      .finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
          if (this.activeRunController === controller) this.activeRunController = undefined;
          this.activeRunCompletion = undefined;
        }
        this.releaseSessionLeaseIfIdle();
      });
    this.activeRunCompletion = completion;
    return { runId, messageId, completion };
  }

  cancelCurrentRun(): void {
    if (this.activeRun) this.cancelRun(this.activeRun.runId);
    else if (this.state.kind === "maintenance") this.abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    try {
      while (this.activeRun || this.state.kind === "maintenance") {
        if (this.activeRunCompletion) {
          await this.activeRunCompletion;
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
    if (this.activeRun?.runId === runId) {
      this.commandRuntime.subagents?.cancelParent(this.activeRun.runId, "Current turn interrupted.");
      this.pendingPermission?.resolve({ approved: false, scope: "once", message: "Current turn interrupted." });
      this.pendingPermission = undefined;
      this.activeRunController?.abort(new Error("Current turn interrupted."));
      return true;
    }
    return false;
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

  /**
   * 命令执行层借用交互宿主的互斥、租约和关闭等待，但具体调用哪个服务由命令层决定。
   * 这样 runtime 不需要为 Model、Memory、MCP 等能力逐个暴露转发方法。
   */
  async runExclusiveOperation<T>(
    operation: RuntimeOperation,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      operation,
      async () => await execute(controller.signal),
      controller
    );
  }

  /**
   * 后台命令立即返回句柄，但在 completion 收尾前仍占用当前交互会话。
   * runtime 只跟踪生命周期，不认识子代理等具体领域对象。
   */
  startBackgroundOperation<T extends BackgroundOperation>(
    operation: RuntimeOperation,
    start: (signal: AbortSignal) => T
  ): T {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error(`Cannot start ${publicOperationName(operation)} while the runtime is busy.`);
    }
    const leaseState = this.acquireSessionLease(this.getInfo().sessionId);
    const controller = new AbortController();
    this.abortController = controller;
    this.setState({ kind: "maintenance", operation });
    try {
      const submitted = start(controller.signal);
      const completion = submitted.completion.then(() => undefined, () => undefined);
      this.activeOperationCompletion = completion;
      const release = (): void => {
        if (this.activeOperationCompletion !== completion) return;
        this.activeOperationCompletion = undefined;
        if (this.abortController === controller) this.abortController = undefined;
        this.setState({ kind: "idle" });
        this.releaseSessionLeaseIfIdle();
      };
      void submitted.completion.then(release, release);
      return submitted;
    } catch (error) {
      if (this.abortController === controller) this.abortController = undefined;
      this.setState({ kind: "idle" });
      this.releaseSessionLease(leaseState);
      throw error;
    }
  }

  async compactConversation(hint?: string): Promise<string> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      "compact",
      async () => {
        const info = this.getInfo();
        const runId = randomUUID();
        const run = this.standaloneRun(info.sessionId, runId, hint ?? "Compact conversation");
        this.emit({
          ...this.eventBase(run),
          type: "compact.started",
          hint: hint === undefined ? undefined : redactSecrets(hint)
        });
        const rawSummary = await this.commandRuntime.agent.compactConversation(hint, controller.signal);
        const summary = redactSecrets(rawSummary);
        const context = await this.commandRuntime.agent.contextStatus();
        this.emit({ ...this.eventBase(run), type: "compact.completed", summary, context });
        return summary;
      },
      controller
    );
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    return {
      revision: this.revision,
      info: this.snapshotInfo(),
      permissionMode: this.commandRuntime.agent.getPermissionMode(),
      state: cloneRunState(this.state)
    };
  }

  private snapshotInfo(): AgentSessionInfo {
    try {
      return this.getInfo();
    } catch (error) {
      // 终态事件仍需带闭合快照；provider/setup 失败后 getInfo 也可能暂时不可用。
      if (this.lastInfo) return this.lastInfo;
      throw error;
    }
  }

  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void {
    return this.updates.subscribe(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelCurrentRun();
    this.closePromise = (async () => {
      const activeWriters = Promise.all([
        this.activeRunCompletion,
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
    operation: RuntimeOperation,
    execute: () => Promise<T>,
    operationAbortController?: AbortController,
    sessionId = this.getInfo().sessionId
  ): Promise<T> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle" || this.activeRun) {
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

  private failUncaughtRun(run: AgentRun, error: unknown): AgentRunOutcome {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const durationMs = Math.max(0, Date.now() - run.startedAtMs);
    run.status = "failed";
    this.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: message });
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

  private async executeRun(run: AgentRun, signal: AbortSignal): Promise<AgentRunOutcome> {
    const agent = this.commandRuntime.agent;
    const startedAtMs = Date.now();
    await this.commandRuntime.refreshSkills();
    const info = this.getInfo();
    run.sessionId = info.sessionId;
    run.status = "thinking";
    run.startedAt = new Date(startedAtMs).toISOString();
    this.commandRuntime.setSubagentParentRunId(run.runId);
    this.tools.clear();
    if (!run.continuation) {
      this.emit({
        ...this.eventBase(run),
        type: "message.user",
        messageId: run.messageId,
        content: run.input
      });
    }
    this.emit({
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
      let turn: AgentTurnOutcome | undefined;
      // Chat/Plan 只驱动一个 AgentSession 回合；Plan 的只读工具限制由 Session 负责。
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
        : agent.prompt(run.input, runOptions);
      for await (const event of stream) {
        streamFailure ??= this.handleAgentEvent(run, event);
        if (event.type === "done") {
          terminalEvents += 1;
          turn = event.outcome;
        }
      }
      // 非协作嵌入方可能在 AbortSignal 后仍吐出一个“完成”事件；取消优先，不能把晚到的
      // 结果写成成功回合。
      if (signal.aborted && turn?.status !== "cancelled") throw new Error("Current turn cancelled.");
      if (terminalEvents !== 1 || !turn) {
        throw new Error(terminalEvents > 1
          ? "Agent stream emitted multiple terminal results."
          : streamFailure ?? "Agent stream ended without a terminal result.");
      }
      const durationMs = Date.now() - startedAtMs;
      const context = await agent.contextStatus();
      this.emit({ ...this.eventBase(run), type: "context.updated", context });
      if (turn.status === "completed") {
        if (turn.stopReason !== "completion_gate") {
          return this.failRun(
            run,
            durationMs,
            `Completed outcome bypassed the Completion Gate (${turn.stopReason}).`,
            turn
          );
        }
        return this.completeRun(run, durationMs, turn);
      }
      if (turn.status === "incomplete") return this.incompleteRun(run, durationMs, turn);
      if (turn.status === "blocked") return this.blockRun(run, durationMs, turn);
      if (turn.status === "cancelled") {
        return this.cancelledRun(run, durationMs, turn.error ?? "Current turn cancelled.", turn);
      }
      if (turn.status === "aborted") return this.abortRun(run, durationMs, turn.error ?? "Current turn interrupted.", turn);
      return this.failRun(run, durationMs, turn.error ?? "Task verification failed.", turn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;
      if (signal.aborted) {
        const reason = "Current turn cancelled.";
        return this.cancelledRun(run, durationMs, reason);
      }
      agent.recordError(error);
      return this.failRun(run, durationMs, message);
    } finally {
      this.pendingPermission = undefined;
      this.commandRuntime.setSubagentParentRunId(undefined);
      this.tools.clear();
    }
  }

  private completeRun(run: ActiveRunSnapshot, durationMs: number, turn: AgentTurnOutcome): AgentRunOutcome {
    run.status = "completed";
    this.emit({
      ...this.eventBase(run),
      type: "run.completed",
      durationMs,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return { runId: run.runId, durationMs, ...turn };
  }

  private incompleteRun(run: ActiveRunSnapshot, durationMs: number, turn: AgentTurnOutcome): AgentRunOutcome {
    const reason = turn.error ?? incompleteReason(turn);
    run.status = "incomplete";
    this.emit({
      ...this.eventBase(run),
      type: "run.incomplete",
      durationMs,
      reason: redactSecrets(reason),
      resumable: turn.resumable,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return { runId: run.runId, durationMs, ...turn, error: turn.error ?? redactSecrets(reason) };
  }

  private blockRun(run: ActiveRunSnapshot, durationMs: number, turn: AgentTurnOutcome): AgentRunOutcome {
    const summary = redactSecrets(turn.error ?? "The current task is blocked.");
    const requiredAction = turn.requiredAction === undefined ? undefined : redactSecrets(turn.requiredAction);
    run.status = "blocked";
    this.emit({
      ...this.eventBase(run),
      type: "run.blocked",
      durationMs,
      reason: normalizeBlockedReason(turn.blockedReason),
      summary,
      requiredAction,
      affectedTodoIds: turn.affectedTodoIds,
      resumable: turn.resumable,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return {
      runId: run.runId,
      durationMs,
      ...turn,
      error: summary,
      requiredAction
    };
  }

  private cancelledRun(
    run: ActiveRunSnapshot,
    durationMs: number,
    reason: string,
    turn?: AgentTurnOutcome
  ): AgentRunOutcome {
    const publicReason = redactSecrets(reason);
    run.status = "cancelled";
    this.emit({
      ...this.eventBase(run),
      type: "run.cancelled",
      durationMs,
      reason: publicReason,
      stopReason: turn?.stopReason ?? "cancelled",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      usage: turn?.usage
    });
    return {
      runId: run.runId,
      status: "cancelled",
      stopReason: "cancelled",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      error: publicReason
    };
  }

  private abortRun(
    run: ActiveRunSnapshot,
    durationMs: number,
    reason: string,
    turn?: AgentTurnOutcome
  ): AgentRunOutcome {
    const publicReason = redactSecrets(reason);
    run.status = "aborted";
    this.emit({
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
    this.emit({
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
    event: AgentSessionEvent
  ): string | undefined {
    if (event.type === "status") {
      run.status = event.status === "waiting_permission"
        ? "waiting_permission"
        : event.status === "running"
          ? "running"
          : event.status === "error"
            ? "failed"
            : event.status;
      // AgentSession 的 status 事件没有对应的 host event，但它仍然是前台状态的事实来源。
      // 收尾阶段可能还要清理断点或写入终态；如果这里不发布快照，UI 会一直停在上一个
      // reasoning/tool 状态，直到后续的 run.completed 才有机会重新同步。
      this.syncActiveRunStatus(run);
      return event.status === "error" ? "Agent run failed." : undefined;
    }

    if (event.type === "message.user") {
      this.emit({
        ...this.eventBase(run),
        type: event.type,
        messageId: event.messageId,
        content: redactSecrets(event.content),
        delivery: event.delivery
      });
      return undefined;
    }

    if (event.type === "context.retrying") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "assistant.delta" || event.type === "assistant.completed") {
      this.emit({
        ...this.eventBase(run),
        type: event.type,
        content: redactSecrets(event.content)
      });
      return undefined;
    }

    if (event.type === "reasoning.started") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "reasoning.delta") {
      this.emit({ ...this.eventBase(run), type: event.type, content: redactSecrets(event.content) });
      return undefined;
    }

    if (event.type === "reasoning.completed") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "tool.started") {
      run.status = "running";
      const args = redactSensitiveValue(event.args);
      const display = redactToolDisplay(event.display);
      this.tools.set(event.toolCallId, { startedAtMs: Date.now() });
      this.emit({
        ...this.eventBase(run),
        ...event,
        args,
        description: event.description === undefined ? undefined : redactSecrets(event.description),
        display
      });
      return undefined;
    }

    if (event.type === "tool.progress") {
      const update = redactSensitiveValue(event.update) as typeof event.update;
      this.emit({ ...this.eventBase(run), ...event, update });
      return undefined;
    }

    if (event.type === "tool.completed") {
      this.completeTool(run, event.toolCallId, event.tool, event.result, event.durationMs);
      return undefined;
    }

    if (event.type === "tool.failed") {
      this.failTool(run, event.toolCallId, event.tool, event.error, event.result, event.durationMs);
      return undefined;
    }

    if (event.type === "error") {
      return event.fatal === false ? undefined : event.message;
    }
    return undefined;
  }

  private async waitForPermission(run: ActiveRunSnapshot, request: AgentPermissionEventRequest): Promise<AgentPermissionResult> {
    const toolCallId = request.toolCallId;
    const requestId = randomUUID();
    const publicRequest = redactPermissionRequest(request);
    const result = await new Promise<AgentPermissionResult>((resolve) => {
      this.pendingPermission = {
        sessionId: run.sessionId,
        runId: run.runId,
        requestId,
        toolCallId,
        request: publicRequest,
        resolve
      };
      this.emit({ ...this.eventBase(run), type: "permission.requested", requestId, toolCallId, request: publicRequest });
    });
    this.emit({
      ...this.eventBase(run),
      type: "permission.resolved",
      requestId,
      toolCallId,
      tool: publicRequest.tool,
      approved: result.approved,
      scope: result.scope,
      message: result.message === undefined ? undefined : redactSecrets(result.message)
    });
    return result;
  }

  private completeTool(
    run: ActiveRunSnapshot,
    toolCallId: string,
    tool: string,
    result: unknown,
    reportedDurationMs?: number
  ): void {
    const active = this.tools.get(toolCallId);
    const durationMs = reportedDurationMs
      ?? readNumber(result, "durationMs")
      ?? (active ? Date.now() - active.startedAtMs : undefined);
    const publicResult = redactSensitiveValue(result);
    this.emit({ ...this.eventBase(run), type: "tool.completed", toolCallId, tool, result: publicResult, durationMs });
    this.tools.delete(toolCallId);
  }

  private failTool(
    run: ActiveRunSnapshot,
    toolCallId: string,
    tool: string,
    error: string,
    result?: unknown,
    reportedDurationMs?: number
  ): void {
    const active = this.tools.get(toolCallId);
    const durationMs = reportedDurationMs
      ?? readNumber(result, "durationMs")
      ?? (active ? Date.now() - active.startedAtMs : undefined);
    const publicError = redactSecrets(error);
    const publicResult = result === undefined ? undefined : redactSensitiveValue(result);
    this.emit({
      ...this.eventBase(run),
      type: "tool.failed",
      toolCallId,
      tool,
      error: publicError,
      result: publicResult,
      durationMs
    });
    this.tools.delete(toolCallId);
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

  private emit(event: AgentHostEvent): void {
    this.state = reduceInteractiveRunState(this.state, event);
    this.revision += 1;
    this.updates.emit({ event, snapshot: this.getSnapshot() });
  }

  private setState(state: InteractiveRunState): void {
    this.state = state;
    this.publishSnapshot();
  }

  private syncActiveRunStatus(run: ActiveRunSnapshot): void {
    if (this.state.kind !== "runs" || this.state.activeRun.runId !== run.runId) return;
    this.state = {
      ...this.state,
      activeRun: { ...this.state.activeRun, status: run.status }
    };
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    this.revision += 1;
    this.updates.emit({ snapshot: this.getSnapshot() });
  }
}

export async function createInteractiveAgentHost(workspaceRoot: string, options?: CommandRuntimeOptions): Promise<InteractiveAgentHost> {
  const sessionLeases = await SessionLeaseStore.open(options?.persistenceRoot ?? workspaceRoot);
  let commandRuntime: CommandRuntime | undefined;
  try {
    commandRuntime = await createCommandRuntime(workspaceRoot, options);
    return {
      runtime: new InteractiveAgentRuntime(commandRuntime, { sessionLeases }),
      commands: commandRuntime
    };
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
      activeRun: { ...state.activeRun },
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

function publicOperationName(operation: RuntimeOperation): string {
  if (operation === "permission") return "a permission update";
  if (operation === "switch_model") return "model switching";
  if (operation === "refresh_model") return "model refresh";
  if (operation === "model_catalog") return "model catalog refresh";
  if (operation === "resume") return "session resume";
  if (operation === "compact") return "conversation compaction";
  if (operation === "mcp") return "MCP reconnection";
  if (operation === "memory") return "a memory command";
  if (operation === "checkpoint") return "checkpoint restore";
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

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function normalizeBlockedReason(reason: string | undefined): BlockedReason {
  if (
    reason === "missing_user_input"
    || reason === "waiting_for_approval"
    || reason === "permission_denied"
    || reason === "missing_dependency"
    || reason === "environment_unavailable"
    || reason === "external_service_failure"
    || reason === "unsafe_action_required"
  ) return reason;
  return "environment_unavailable";
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
