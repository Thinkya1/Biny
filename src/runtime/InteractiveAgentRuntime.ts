import { randomUUID } from "node:crypto";
import type { AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { AgentPermissionResult, AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { ExtensionSection } from "../extensions/report.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionSummary } from "../session/events.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import type { TaskRunStore } from "../harness/TaskRunStore.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
import {
  SubagentTaskAbortedError,
  type SubagentTaskSnapshot
} from "./SubagentTaskManager.js";
import { RootRunLedger, type RootRunLedgerSnapshot, type RootRunLedgerStatus } from "./RootRunLedger.js";
import { RootRunScheduler } from "./RootRunScheduler.js";
import { TaskRunCoordinator } from "./TaskRunCoordinator.js";
import type {
  ActiveRunSnapshot,
  AgentHostEvent,
  AgentPermissionEventRequest,
  InteractiveRuntimeSnapshot,
  PendingPermissionSnapshot,
  RuntimeOperation
} from "./agentEvents.js";

type ExclusiveRuntimeOperation = RuntimeOperation | "permission";

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
  /** Injected by the composition root; tests may omit durable persistence. */
  runLedger?: RootRunLedger;
  /** Injected by the composition root; tests may omit durable task persistence. */
  taskRunStore?: TaskRunStore;
}

interface QueuedAgentRun extends ActiveRunSnapshot {
  queuedAtMs: number;
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

/**
 * UI-independent interactive host for AgentSession. It owns run queuing,
 * permission waits and AbortController state while AgentSession continues to
 * own model context, tools and JSONL persistence.
 */
export class InteractiveAgentRuntime {
  private static readonly maxQueuedRuns = 32;
  private static readonly defaultShutdownDrainMs = 2_000;
  private readonly events = new AgentEventBus<AgentHostEvent>();
  private readonly rootRunScheduler: RootRunScheduler<QueuedAgentRun, AgentRunOutcome>;
  private readonly runLedger: RootRunLedger | undefined;
  private readonly taskRunCoordinator: TaskRunCoordinator;
  private readonly tools = new Map<string, ActiveTool>();
  private readonly permissionRequestIds = new Map<string, string>();
  private directRun: ActiveRunSnapshot | undefined;
  private pendingPermission: PendingPermission | undefined;
  private abortController: AbortController | undefined;
  private activeOperation: ExclusiveRuntimeOperation | undefined;
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
    this.runLedger = options.runLedger;
    this.taskRunCoordinator = new TaskRunCoordinator({
      runtime: commandRuntime,
      taskRunStore: options.taskRunStore
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

  submitPrompt(input: string, mode: AgentRunMode = "chat"): SubmittedAgentRun {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.activeOperation) throw new Error(`Cannot submit a prompt while ${publicOperationName(this.activeOperation)} is running.`);
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    const sessionId = this.getInfo().sessionId;
    const runId = randomUUID();
    const messageId = randomUUID();
    const queuedAtMs = Date.now();
    const run: QueuedAgentRun = {
      sessionId,
      runId,
      messageId,
      input,
      mode,
      status: "queued",
      startedAt: new Date(queuedAtMs).toISOString(),
      queuedAtMs
    };
    this.admitRootRun(run);
    try {
      const submitted = this.rootRunScheduler.submit(run);
      return { runId, messageId, queued: submitted.queued, completion: submitted.completion };
    } catch (error) {
      this.persistTerminalRun(run, "failed", 0, undefined, `Run admission rejected: ${errorMessage(error)}`);
      throw error;
    }
  }

  cancelCurrentRun(): void {
    const activeRun = this.rootRunScheduler.activeRun ?? this.directRun;
    if (activeRun) this.cancelRun(activeRun.runId);
    else if (this.activeOperation) this.abortController?.abort();
    for (const queued of this.rootRunScheduler.queuedRuns) this.cancelRun(queued.runId);
  }

  async waitForIdle(): Promise<void> {
    while (this.rootRunScheduler.activeRun || this.rootRunScheduler.queueLength || this.directRun || this.activeOperation) {
      if (this.rootRunScheduler.activeRun || this.rootRunScheduler.queueLength) {
        await this.rootRunScheduler.waitForIdle();
      } else if (this.activeOperationCompletion) {
        await this.activeOperationCompletion;
      } else {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
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
    if (this.directRun?.runId === runId && this.abortController) {
      this.abortController.abort();
      this.commandRuntime.cancelSubagentTasks(runId, "Current turn interrupted.");
      this.pendingPermission?.resolve({ approved: false, scope: "once", message: "Current turn interrupted." });
      this.pendingPermission = undefined;
      return true;
    }
    return this.rootRunScheduler.cancel(runId, "Cancelled before execution.");
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
    return await this.runMaintenanceOperation("resume", async () => await this.commandRuntime.agent.resume(session));
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.commandRuntime.agent.listSessions();
  }

  extensionReport(section?: ExtensionSection): string {
    return this.commandRuntime.extensionReport(section);
  }

  listSubagentTasks(): SubagentTaskSnapshot[] {
    return this.commandRuntime.listSubagentTasks();
  }

  /** Durable root-run history, intentionally separate from stable session JSONL events. */
  listRootRunSnapshots(): RootRunLedgerSnapshot[] {
    return this.runLedger?.listSnapshots() ?? [];
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
      async () => await this.executeDirectSubagentTask(task, controller),
      controller
    );
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
      info: this.getInfo(),
      permissionMode: this.getPermissionMode(),
      activeOperation: this.activeOperation === "permission" ? undefined : this.activeOperation,
      activeRun: this.rootRunScheduler.activeRun
        ? { ...this.rootRunScheduler.activeRun }
        : this.directRun ? { ...this.directRun } : undefined,
      pendingPermission: this.pendingPermission ? {
        sessionId: this.pendingPermission.sessionId,
        runId: this.pendingPermission.runId,
        requestId: this.pendingPermission.requestId,
        toolCallId: this.pendingPermission.toolCallId,
        request: { ...this.pendingPermission.request }
      } : undefined,
      queuedRuns: this.rootRunScheduler.queuedRuns.map(({ runId, messageId, input, mode }) => ({ runId, messageId, input, mode }))
    };
  }

  subscribe(listener: (event: AgentHostEvent) => void): () => void {
    return this.events.subscribe(listener);
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
        this.runLedger?.close();
      }
    });
    return this.commandRuntimeClosePromise;
  }

  private async runMaintenanceOperation<T>(
    operation: ExclusiveRuntimeOperation,
    execute: () => Promise<T>,
    operationAbortController?: AbortController
  ): Promise<T> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.rootRunScheduler.activeRun || this.rootRunScheduler.queueLength || this.directRun || this.activeOperation) {
      throw new Error(`Cannot start ${publicOperationName(operation)} while the runtime is busy.`);
    }
    this.activeOperation = operation;
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
        this.activeOperation = undefined;
      }
    }
  }

  private async executeDirectSubagentTask(task: string, controller: AbortController): Promise<string> {
    const input = task.trim();
    if (!input) throw new Error("Subagent task cannot be empty.");
    const info = this.getInfo();
    const subagentInfo = this.commandRuntime.getSubagentInfo();
    const run = this.standaloneRun(info.sessionId, randomUUID(), input);
    const taskId = randomUUID();
    const startedAtMs = Date.now();
    const publicInput = redactSecrets(input);
    this.admitRootRun(run);
    this.startRootRun(run);
    this.directRun = run;
    this.abortController = controller;
    this.events.emit({ ...this.eventBase(run), type: "message.user", messageId: run.messageId, content: publicInput });
    this.events.emit({
      ...this.eventBase(run),
      type: "run.started",
      messageId: run.messageId,
      input: publicInput,
      mode: run.mode,
      model: {
        alias: subagentInfo.modelAlias,
        provider: subagentInfo.provider,
        label: subagentInfo.modelLabel,
        reasoning: subagentInfo.reasoningLabel
      },
      skills: info.skills ?? []
    });
    this.events.emit({
      ...this.eventBase(run),
      type: "tool.started",
      toolCallId: taskId,
      tool: "delegate_task",
      args: { task: publicInput },
      description: "Run a bounded read-only subagent",
      display: { kind: "generic", summary: "Delegate read-only investigation", detail: publicInput }
    });
    this.events.emit({ ...this.eventBase(run), type: "reasoning.status", messageId: run.messageId, status: "正在运行只读子任务" });

    try {
      const output = await this.commandRuntime.runSubagentTask(input, {
        taskId,
        parentRunId: run.runId,
        signal: controller.signal
      });
      const publicOutput = redactSecrets(output);
      const durationMs = Date.now() - startedAtMs;
      const ledgerFailure = this.persistTerminalRun(run, "completed", durationMs, undefined, undefined);
      if (ledgerFailure) throw new Error(ledgerFailure);
      run.status = "completed";
      this.events.emit({ ...this.eventBase(run), type: "tool.completed", toolCallId: taskId, tool: "delegate_task", result: publicOutput, durationMs });
      this.events.emit({ ...this.eventBase(run), type: "assistant.completed", messageId: run.messageId, content: publicOutput });
      this.events.emit({ ...this.eventBase(run), type: "run.completed", durationMs });
      return publicOutput;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startedAtMs;
      const publicMessage = redactSecrets(failure.message);
      const aborted = controller.signal.aborted || failure instanceof SubagentTaskAbortedError;
      const ledgerFailure = this.persistTerminalRun(
        run,
        aborted ? "aborted" : "failed",
        durationMs,
        undefined,
        publicMessage
      );
      const terminalMessage = ledgerFailure ?? publicMessage;
      this.events.emit({ ...this.eventBase(run), type: "tool.failed", toolCallId: taskId, tool: "delegate_task", error: terminalMessage, durationMs });
      if (aborted && !ledgerFailure) {
        run.status = "aborted";
        this.events.emit({ ...this.eventBase(run), type: "run.aborted", durationMs, reason: terminalMessage });
      } else {
        run.status = "failed";
        this.commandRuntime.agent.recordError(failure);
        this.events.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: terminalMessage });
      }
      if (!ledgerFailure && publicMessage === failure.message) throw failure;
      const publicFailure = new Error(terminalMessage);
      publicFailure.name = failure.name;
      throw publicFailure;
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
      if (this.directRun?.runId === run.runId) this.directRun = undefined;
    }
  }

  private abortQueuedRun(run: QueuedAgentRun, reason: string): AgentRunOutcome {
    const persistenceFailure = this.persistTerminalRun(run, "aborted", 0, undefined, reason);
    if (persistenceFailure) return this.emitLedgerFailure(run, 0, persistenceFailure);
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
    const persistenceFailure = this.persistTerminalRun(run, "failed", durationMs, undefined, message);
    if (persistenceFailure) return this.emitLedgerFailure(run, durationMs, persistenceFailure);
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
    this.startRootRun(run);
    this.commandRuntime.setSubagentParentRunId(run.runId);
    this.tools.clear();
    this.permissionRequestIds.clear();
    this.events.emit({
      ...this.eventBase(run),
      type: "message.user",
      messageId: run.messageId,
      content: run.input
    });
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
      const { turn } = await this.taskRunCoordinator.execute({
        runId: run.runId,
        sessionId: run.sessionId,
        input: run.input,
        mode: run.mode,
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
      });
      const durationMs = Date.now() - startedAtMs;
      if (turn.output && (turn.status === "completed" || turn.status === "incomplete")) {
        this.emitAssistantCompleted(run, turn.output);
      }
      const context = await agent.contextStatus();
      this.events.emit({ ...this.eventBase(run), type: "context.updated", context });
      if (turn.status === "completed") {
        const outcome = this.completeRun(run, durationMs, turn);
        if (outcome.status === "completed") agent.rememberSuccessfulTask?.(run.input, turn.output);
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
    const persistenceFailure = this.persistTerminalRun(run, "completed", durationMs, turn.usage, undefined);
    if (persistenceFailure) return this.emitLedgerFailure(run, durationMs, persistenceFailure);
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
    const persistenceFailure = this.persistTerminalRun(run, "incomplete", durationMs, turn.usage, reason);
    if (persistenceFailure) return this.emitLedgerFailure(run, durationMs, persistenceFailure, turn.usage);
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
    const persistenceFailure = this.persistTerminalRun(run, "aborted", durationMs, turn?.usage, publicReason);
    if (persistenceFailure) return this.emitLedgerFailure(run, durationMs, persistenceFailure);
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
    const persistenceFailure = this.persistTerminalRun(run, "failed", durationMs, turn?.usage, publicError);
    if (persistenceFailure) return this.emitLedgerFailure(run, durationMs, persistenceFailure, turn?.usage);
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

  private admitRootRun(run: ActiveRunSnapshot): void {
    this.runLedger?.admit({
      runId: run.runId,
      sessionId: run.sessionId,
      messageId: run.messageId,
      mode: run.mode,
      input: run.input,
      queuedAt: run.startedAt
    });
  }

  private startRootRun(run: ActiveRunSnapshot): void {
    this.runLedger?.start(run.runId, run.startedAt);
  }

  private persistTerminalRun(
    run: ActiveRunSnapshot,
    status: Extract<RootRunLedgerStatus, "completed" | "incomplete" | "failed" | "aborted">,
    durationMs: number,
    usage: SessionUsage | undefined,
    reason: string | undefined
  ): string | undefined {
    if (!this.runLedger) return undefined;
    const details = {
      endedAt: new Date().toISOString(),
      durationMs,
      usage,
      reason
    };
    try {
      if (status === "completed") this.runLedger.complete(run.runId, details);
      else if (status === "incomplete") this.runLedger.incomplete(run.runId, details);
      else if (status === "aborted") this.runLedger.abort(run.runId, details);
      else this.runLedger.fail(run.runId, details);
      return undefined;
    } catch (error) {
      return `Root run ledger persistence failed: ${redactSecrets(errorMessage(error))}`;
    }
  }

  private emitLedgerFailure(
    run: ActiveRunSnapshot,
    durationMs: number,
    message: string,
    usage?: SessionUsage
  ): AgentRunOutcome {
    const publicMessage = redactSecrets(message);
    run.status = "failed";
    this.commandRuntime.agent.recordError(new Error(publicMessage));
    this.events.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: publicMessage });
    return {
      runId: run.runId,
      status: "failed",
      stopReason: "provider_error",
      steps: 0,
      output: "",
      durationMs,
      usage,
      error: publicMessage
    };
  }

  private handleAgentEvent(
    run: ActiveRunSnapshot,
    event: AgentSessionEvent,
    reasoningActive: boolean
  ): { reasoningActive: boolean; done?: AgentTurnOutcome; failure?: string } {
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
      return { reasoningActive, done: event.outcome };
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
}

export async function createInteractiveAgentRuntime(workspaceRoot: string, options?: CommandRuntimeOptions): Promise<InteractiveAgentRuntime> {
  const runLedger = await RootRunLedger.open(options?.persistenceRoot ?? workspaceRoot);
  let commandRuntime: CommandRuntime | undefined;
  try {
    commandRuntime = await createCommandRuntime(workspaceRoot, options);
    return new InteractiveAgentRuntime(commandRuntime, { runLedger });
  } catch (error) {
    await commandRuntime?.close();
    runLedger.close();
    throw error;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
