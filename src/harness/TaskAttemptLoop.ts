/**
 * A verifier-driven task harness that stays outside AgentSession and the
 * interactive runtime. Products can bind it to an agent, a benchmark, or a
 * workflow-specific verifier without teaching the chat loop how to retry.
 */
import { randomUUID } from "node:crypto";
import type { SessionUsage } from "../session/metadata.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";

const maxPublicTextChars = 4_000;

export type TaskHarnessStatus = "passed" | "failed" | "aborted" | "budget_exhausted";
export type TaskHarnessDecision = "continue" | "retry" | "stop" | "abort";

export interface TaskAttemptBudget {
  maxAttempts: number;
  maxRuntimeSteps?: number;
  maxWallTimeMs?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
}

export interface TaskAttemptContext<TTask> {
  taskRunId: string;
  attemptId: string;
  attemptNumber: number;
  task: TTask;
  feedback?: string;
  remainingRuntimeSteps?: number;
  signal?: AbortSignal;
}

export interface TaskAttemptResult {
  output: string;
  runtimeSteps: number;
  usage?: SessionUsage;
}

export interface TaskVerification {
  passed: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface TaskVerificationContext<TTask> extends TaskAttemptContext<TTask> {
  output: string;
  runtimeSteps: number;
  usage?: SessionUsage;
}

export interface TaskDecisionContext<TTask> extends TaskVerificationContext<TTask> {
  verification: TaskVerification;
  elapsedMs: number;
  runtimeStepsUsed: number;
  totalTokensUsed: number;
  costUsdUsed: number;
}

export type TaskFeedbackContext<TTask> = TaskDecisionContext<TTask>;

export interface TaskAttemptSnapshot {
  attemptId: string;
  attemptNumber: number;
  feedback?: string;
  output?: string;
  error?: string;
  runtimeSteps: number;
  usage?: SessionUsage;
  verification?: TaskVerification;
}

export interface TaskHarnessRunResult {
  taskRunId: string;
  status: TaskHarnessStatus;
  attempts: TaskAttemptSnapshot[];
  elapsedMs: number;
  runtimeStepsUsed: number;
  totalTokensUsed: number;
  costUsdUsed: number;
  terminalReason: string;
}

export type TaskHarnessEvent =
  | { type: "task.started"; taskRunId: string; timestamp: string; budget: TaskAttemptBudget }
  | { type: "attempt.started"; taskRunId: string; timestamp: string; attemptId: string; attemptNumber: number; feedback?: string }
  | { type: "attempt.completed"; taskRunId: string; timestamp: string; attempt: TaskAttemptSnapshot }
  | { type: "verifier.completed"; taskRunId: string; timestamp: string; attemptId: string; attemptNumber: number; verification: TaskVerification }
  | { type: "decision.made"; taskRunId: string; timestamp: string; attemptId: string; attemptNumber: number; decision: TaskHarnessDecision; reason: string }
  | { type: "task.terminal"; taskRunId: string; timestamp: string; result: TaskHarnessRunResult };

export interface TaskAttemptLoopOptions<TTask> {
  budget: TaskAttemptBudget;
  execute(context: TaskAttemptContext<TTask>): Promise<TaskAttemptResult>;
  verify(context: TaskVerificationContext<TTask>): Promise<TaskVerification>;
  decide?(context: TaskDecisionContext<TTask>): Promise<TaskHarnessDecision> | TaskHarnessDecision;
  feedbackPrompt?(context: TaskFeedbackContext<TTask>): Promise<string | undefined> | string | undefined;
  onEvent?(event: TaskHarnessEvent): void;
  now?(): number;
  createId?(): string;
}

/**
 * Runs bounded attempts until a verifier passes, an explicit decision stops,
 * cancellation arrives, or an attempt/step/wall-clock budget is exhausted.
 */
export class TaskAttemptLoop<TTask> {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly budgetError: string | undefined;

  constructor(private readonly options: TaskAttemptLoopOptions<TTask>) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.budgetError = validateBudget(options.budget);
  }

  async run(task: TTask, signal?: AbortSignal, taskRunId = this.createId()): Promise<TaskHarnessRunResult> {
    const startedAtMs = this.now();
    const attempts: TaskAttemptSnapshot[] = [];
    let runtimeStepsUsed = 0;
    let totalTokensUsed = 0;
    let costUsdUsed = 0;
    let terminalEmitted = false;
    const finish = (status: TaskHarnessStatus, terminalReason: string): TaskHarnessRunResult => {
      const result: TaskHarnessRunResult = {
        taskRunId,
        status,
        attempts: attempts.map(cloneAttempt),
        elapsedMs: elapsedSince(startedAtMs, this.now()),
        runtimeStepsUsed,
        totalTokensUsed,
        costUsdUsed,
        terminalReason: publicText(terminalReason)
      };
      if (!terminalEmitted) {
        terminalEmitted = true;
        this.emit({ type: "task.terminal", taskRunId, timestamp: this.timestamp(), result: cloneResult(result) });
      }
      return result;
    };

    this.emit({ type: "task.started", taskRunId, timestamp: this.timestamp(), budget: cloneBudget(this.options.budget) });
    if (this.budgetError) return finish("failed", this.budgetError);
    if (signal?.aborted) return finish("aborted", abortReason(signal));

    let feedback: string | undefined;
    for (let attemptNumber = 1; attemptNumber <= this.options.budget.maxAttempts; attemptNumber += 1) {
      if (signal?.aborted) return finish("aborted", abortReason(signal));
      if (wallBudgetReached(this.options.budget, elapsedSince(startedAtMs, this.now()))) {
        return finish("budget_exhausted", "Wall-clock budget exhausted before another attempt could start.");
      }
      if (stepBudgetReached(this.options.budget, runtimeStepsUsed)) {
        return finish("budget_exhausted", "Runtime-step budget exhausted before another attempt could start.");
      }
      if (tokenBudgetReached(this.options.budget, totalTokensUsed)) {
        return finish("budget_exhausted", "Token budget exhausted before another attempt could start.");
      }
      if (costBudgetReached(this.options.budget, costUsdUsed)) {
        return finish("budget_exhausted", "Cost budget exhausted before another attempt could start.");
      }

      const attemptId = this.createId();
      const attemptSignal = boundedAttemptSignal(signal, this.options.budget, elapsedSince(startedAtMs, this.now()));
      const context: TaskAttemptContext<TTask> = {
        taskRunId,
        attemptId,
        attemptNumber,
        task,
        feedback,
        remainingRuntimeSteps: this.options.budget.maxRuntimeSteps === undefined
          ? undefined
          : Math.max(0, this.options.budget.maxRuntimeSteps - runtimeStepsUsed),
        signal: attemptSignal
      };
      this.emit({
        type: "attempt.started",
        taskRunId,
        timestamp: this.timestamp(),
        attemptId,
        attemptNumber,
        feedback: feedback === undefined ? undefined : publicText(feedback)
      });

      let attemptResult: TaskAttemptResult | undefined;
      let attemptFailure: string | undefined;
      try {
        attemptResult = await this.options.execute(context);
        validateAttemptResult(attemptResult);
      } catch (error) {
        attemptFailure = `Attempt execution failed: ${errorText(error)}`;
      }

      if (attemptResult) {
        runtimeStepsUsed += attemptResult.runtimeSteps;
        totalTokensUsed += usageTotalTokens(attemptResult.usage);
        costUsdUsed += attemptResult.usage?.costUsd ?? 0;
      }
      const snapshot: TaskAttemptSnapshot = {
        attemptId,
        attemptNumber,
        feedback: feedback === undefined ? undefined : publicText(feedback),
        output: attemptResult === undefined ? undefined : publicText(attemptResult.output),
        error: attemptFailure === undefined ? undefined : publicText(attemptFailure),
        runtimeSteps: attemptResult?.runtimeSteps ?? 0,
        usage: attemptResult?.usage === undefined ? undefined : publicUsage(attemptResult.usage),
        verification: undefined
      };
      attempts.push(snapshot);
      this.emit({ type: "attempt.completed", taskRunId, timestamp: this.timestamp(), attempt: cloneAttempt(snapshot) });

      if (signal?.aborted) return finish("aborted", abortReason(signal));
      if (wallBudgetExceeded(this.options.budget, elapsedSince(startedAtMs, this.now()))) {
        return finish("budget_exhausted", "Wall-clock budget was exceeded during an attempt.");
      }
      if (stepBudgetExceeded(this.options.budget, runtimeStepsUsed)) {
        return finish("budget_exhausted", "Runtime-step budget was exceeded during an attempt.");
      }
      if (tokenBudgetExceeded(this.options.budget, totalTokensUsed)) {
        return finish("budget_exhausted", "Token budget was exceeded during an attempt.");
      }
      if (costBudgetExceeded(this.options.budget, costUsdUsed)) {
        return finish("budget_exhausted", "Cost budget was exceeded during an attempt.");
      }

      const verification = attemptResult
        ? await this.verifyAttempt(context, attemptResult)
        : { passed: false, summary: attemptFailure ?? "Attempt execution did not return a result.", details: undefined };
      snapshot.verification = verification;
      this.emit({
        type: "verifier.completed",
        taskRunId,
        timestamp: this.timestamp(),
        attemptId,
        attemptNumber,
        verification: publicVerification(verification)
      });

      if (verification.passed) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Verifier accepted the attempt." });
        return finish("passed", verification.summary);
      }
      const decisionContext: TaskDecisionContext<TTask> = {
        ...context,
        output: attemptResult?.output ?? "",
        runtimeSteps: attemptResult?.runtimeSteps ?? 0,
        usage: attemptResult?.usage,
        verification,
        elapsedMs: elapsedSince(startedAtMs, this.now()),
        runtimeStepsUsed,
        totalTokensUsed,
        costUsdUsed
      };
      let decision: TaskHarnessDecision;
      try {
        decision = this.options.decide ? await this.options.decide(decisionContext) : "retry";
        if (!isDecision(decision)) throw new Error(`Invalid harness decision: ${String(decision)}`);
      } catch (error) {
        const reason = `Decision callback failed: ${errorText(error)}`;
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: publicText(reason) });
        return finish("failed", reason);
      }
      if (decision === "abort" || decision === "stop") {
        this.emit({
          type: "decision.made",
          taskRunId,
          timestamp: this.timestamp(),
          attemptId,
          attemptNumber,
          decision,
          reason: publicText(verification.summary)
        });
        return decision === "abort" ? finish("aborted", verification.summary) : finish("failed", verification.summary);
      }
      if (attemptNumber >= this.options.budget.maxAttempts) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Attempt budget exhausted." });
        return finish("budget_exhausted", "Attempt budget exhausted without a passing verification.");
      }
      if (wallBudgetReached(this.options.budget, elapsedSince(startedAtMs, this.now()))) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Wall-clock budget exhausted." });
        return finish("budget_exhausted", "Wall-clock budget exhausted without a passing verification.");
      }
      if (stepBudgetReached(this.options.budget, runtimeStepsUsed)) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Runtime-step budget exhausted." });
        return finish("budget_exhausted", "Runtime-step budget exhausted without a passing verification.");
      }
      if (tokenBudgetReached(this.options.budget, totalTokensUsed)) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Token budget exhausted." });
        return finish("budget_exhausted", "Token budget exhausted without a passing verification.");
      }
      if (costBudgetReached(this.options.budget, costUsdUsed)) {
        this.emit({ type: "decision.made", taskRunId, timestamp: this.timestamp(), attemptId, attemptNumber, decision: "stop", reason: "Cost budget exhausted." });
        return finish("budget_exhausted", "Cost budget exhausted without a passing verification.");
      }
      this.emit({
        type: "decision.made",
        taskRunId,
        timestamp: this.timestamp(),
        attemptId,
        attemptNumber,
        decision,
        reason: publicText(verification.summary)
      });
      if (decision === "continue") {
        feedback = undefined;
        continue;
      }
      try {
        feedback = await this.nextFeedback(decisionContext);
      } catch (error) {
        return finish("failed", `Feedback callback failed: ${errorText(error)}`);
      }
    }
    return finish("budget_exhausted", "Attempt budget exhausted without a passing verification.");
  }

  private async verifyAttempt(context: TaskAttemptContext<TTask>, result: TaskAttemptResult): Promise<TaskVerification> {
    try {
      const verification = await this.options.verify({
        ...context,
        output: result.output,
        runtimeSteps: result.runtimeSteps,
        usage: result.usage
      });
      return validateVerification(verification);
    } catch (error) {
      return { passed: false, summary: `Verifier failed: ${errorText(error)}`, details: undefined };
    }
  }

  private async nextFeedback(context: TaskFeedbackContext<TTask>): Promise<string | undefined> {
    const feedback = this.options.feedbackPrompt
      ? await this.options.feedbackPrompt(context)
      : `The previous attempt did not pass verification: ${publicText(context.verification.summary)}`;
    if (feedback === undefined) return undefined;
    if (typeof feedback !== "string") throw new Error("Feedback callback must return a string or undefined.");
    return publicText(feedback);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private emit(event: TaskHarnessEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Event consumers are observers. They must not leave a bounded harness
      // halfway through an attempt because a dashboard renderer threw.
    }
  }
}

function validateBudget(budget: TaskAttemptBudget): string | undefined {
  if (!Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1) {
    return "Harness maxAttempts must be a positive safe integer.";
  }
  if (budget.maxRuntimeSteps !== undefined && (!Number.isSafeInteger(budget.maxRuntimeSteps) || budget.maxRuntimeSteps < 0)) {
    return "Harness maxRuntimeSteps must be a non-negative safe integer.";
  }
  if (budget.maxWallTimeMs !== undefined && (!Number.isSafeInteger(budget.maxWallTimeMs) || budget.maxWallTimeMs < 0)) {
    return "Harness maxWallTimeMs must be a non-negative safe integer.";
  }
  if (budget.maxTotalTokens !== undefined && (!Number.isSafeInteger(budget.maxTotalTokens) || budget.maxTotalTokens < 0)) {
    return "Harness maxTotalTokens must be a non-negative safe integer.";
  }
  if (budget.maxCostUsd !== undefined && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) {
    return "Harness maxCostUsd must be a non-negative finite number.";
  }
  return undefined;
}

function validateAttemptResult(value: TaskAttemptResult): void {
  if (typeof value !== "object" || value === null || typeof value.output !== "string" || !Number.isSafeInteger(value.runtimeSteps) || value.runtimeSteps < 0) {
    throw new Error("Attempt result must contain a string output and non-negative safe runtimeSteps.");
  }
}

function validateVerification(value: TaskVerification): TaskVerification {
  if (typeof value !== "object" || value === null || typeof value.passed !== "boolean" || typeof value.summary !== "string") {
    throw new Error("Verifier result must contain passed and summary fields.");
  }
  if (value.details !== undefined && (typeof value.details !== "object" || value.details === null || Array.isArray(value.details))) {
    throw new Error("Verifier details must be an object when provided.");
  }
  return {
    passed: value.passed,
    summary: publicText(value.summary),
    details: value.details === undefined ? undefined : publicDetails(value.details)
  };
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

function cloneAttempt(attempt: TaskAttemptSnapshot): TaskAttemptSnapshot {
  return {
    ...attempt,
    usage: attempt.usage === undefined ? undefined : { ...attempt.usage },
    verification: attempt.verification === undefined ? undefined : publicVerification(attempt.verification)
  };
}

function cloneResult(result: TaskHarnessRunResult): TaskHarnessRunResult {
  return {
    ...result,
    attempts: result.attempts.map(cloneAttempt)
  };
}

function publicVerification(verification: TaskVerification): TaskVerification {
  return {
    passed: verification.passed,
    summary: publicText(verification.summary),
    details: verification.details === undefined ? undefined : publicDetails(verification.details)
  };
}

function publicDetails(details: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitiveValue(details);
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

function publicUsage(usage: SessionUsage): SessionUsage {
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

function publicText(value: string): string {
  const redacted = redactSecrets(value).trim();
  if (!redacted) return "(no details)";
  return redacted.length <= maxPublicTextChars ? redacted : `${redacted.slice(0, maxPublicTextChars - 1)}…`;
}

function errorText(error: unknown): string {
  return publicText(error instanceof Error ? error.message : String(error));
}

function elapsedSince(startedAtMs: number, nowMs: number): number {
  const elapsed = nowMs - startedAtMs;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0;
}

function wallBudgetReached(budget: TaskAttemptBudget, elapsedMs: number): boolean {
  return budget.maxWallTimeMs !== undefined && elapsedMs >= budget.maxWallTimeMs;
}

function wallBudgetExceeded(budget: TaskAttemptBudget, elapsedMs: number): boolean {
  return budget.maxWallTimeMs !== undefined && elapsedMs > budget.maxWallTimeMs;
}

function stepBudgetReached(budget: TaskAttemptBudget, runtimeSteps: number): boolean {
  return budget.maxRuntimeSteps !== undefined && runtimeSteps >= budget.maxRuntimeSteps;
}

function stepBudgetExceeded(budget: TaskAttemptBudget, runtimeSteps: number): boolean {
  return budget.maxRuntimeSteps !== undefined && runtimeSteps > budget.maxRuntimeSteps;
}

function tokenBudgetReached(budget: TaskAttemptBudget, totalTokens: number): boolean {
  return budget.maxTotalTokens !== undefined && totalTokens >= budget.maxTotalTokens;
}

function tokenBudgetExceeded(budget: TaskAttemptBudget, totalTokens: number): boolean {
  return budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens;
}

function costBudgetReached(budget: TaskAttemptBudget, costUsd: number): boolean {
  return budget.maxCostUsd !== undefined && costUsd >= budget.maxCostUsd;
}

function costBudgetExceeded(budget: TaskAttemptBudget, costUsd: number): boolean {
  return budget.maxCostUsd !== undefined && costUsd > budget.maxCostUsd;
}

function usageTotalTokens(usage: SessionUsage | undefined): number {
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function boundedAttemptSignal(
  signal: AbortSignal | undefined,
  budget: TaskAttemptBudget,
  elapsedMs: number
): AbortSignal | undefined {
  if (budget.maxWallTimeMs === undefined) return signal;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, budget.maxWallTimeMs - elapsedMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function isDecision(value: unknown): value is TaskHarnessDecision {
  return value === "continue" || value === "retry" || value === "stop" || value === "abort";
}

function abortReason(signal: AbortSignal): string {
  return signal.reason === undefined ? "Task harness aborted." : `Task harness aborted: ${errorText(signal.reason)}`;
}
