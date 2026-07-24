import type { AgentAttachment, AgentRunMode } from "../agent/AgentSession.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import { AcceptanceVerifier } from "../harness/AcceptanceVerifier.js";
import { AgentAttemptExecutor } from "../harness/AgentAttemptExecutor.js";
import { cleanupTask } from "../harness/TaskCleanup.js";
import { compileTaskContract } from "../harness/TaskContractCompiler.js";
import { decideTaskAttempt, judgeTaskTerminal } from "../harness/TaskDecisionEngine.js";
import { TaskAttemptLoop, type TaskAttemptBudget, type TaskHarnessRunResult } from "../harness/TaskAttemptLoop.js";
import { advanceTaskPlan, type TaskPlanProgress } from "../harness/TaskPlanner.js";
import { createTaskContract } from "../harness/TaskContractFactory.js";
import type { TaskRunStore } from "../harness/TaskRunStore.js";
import type { AgentAttemptExecution, TaskCleanupResult, TaskContract, TaskToolEvidence } from "../harness/types.js";
import type { SessionUsage } from "../session/metadata.js";
import type { CommandRuntime } from "./CommandRuntime.js";

export interface TaskRunCoordinatorOptions {
  runtime: CommandRuntime;
  taskRunStore?: TaskRunStore;
}

export interface TaskRunCoordinatorExecution {
  runId: string;
  sessionId: string;
  input: string;
  mode: AgentRunMode;
  attachments?: AgentAttachment[];
  signal: AbortSignal;
  confirmPermission(request: AgentPermissionRequest): Promise<AgentPermissionResult>;
  /** Maps a raw Agent event into the host and returns whether reasoning remains active. */
  onAgentEvent(event: AgentSessionEvent): boolean;
  onReasoningCompleted(): void;
}

export interface TaskRunCoordinatorResult {
  turn: AgentTurnOutcome;
}

/**
 * Owns one durable task's contract, bounded attempts, independent verification,
 * decision policy, cleanup, and persistence. The interactive runtime only maps
 * host events and presents its resulting turn to the user.
 */
export class TaskRunCoordinator {
  private readonly runtime: CommandRuntime;
  private readonly taskRunStore: TaskRunStore | undefined;

  constructor(options: TaskRunCoordinatorOptions) {
    this.runtime = options.runtime;
    this.taskRunStore = options.taskRunStore ?? options.runtime.taskRuns;
  }

  async execute(options: TaskRunCoordinatorExecution): Promise<TaskRunCoordinatorResult> {
    // Keep lightweight host doubles and embedders compatible with the original
    // interactive contract. The durable verifier requires the full CommandRuntime
    // surface; a minimal AgentSession host should still be able to exercise
    // permissions and event ordering without inventing workspace state.
    if (!isDurableRuntime(this.runtime)) return await this.executeCompatibility(options);
    const resolved = await resolveTaskContract(
      this.runtime.workspaceRoot,
      options.input,
      options.mode,
      this.taskRunStore,
      this.runtime.config.workspace.ignore
    );
    const task = resolved.contract;
    const budget = taskBudget(this.runtime);
    let durableTaskCreated = false;
    let latestExecution: AgentAttemptExecution | undefined;
    const executions = new Map<string, AgentAttemptExecution>();
    let reasoningActive = false;
    let cleanupCompleted = false;

    try {
      if (this.taskRunStore) {
        await this.taskRunStore.create({
          taskRunId: options.runId,
          sessionId: options.sessionId,
          rootRunId: options.runId,
          contract: task,
          budget
        });
        durableTaskCreated = true;
        await this.taskRunStore.markRunning(options.runId);
      }

      const updateTaskPlan = async (progress: TaskPlanProgress): Promise<void> => {
        task.plan = advanceTaskPlan(task.plan, progress);
        await this.taskRunStore?.updateContract(options.runId, task);
      };
      const finalizeTaskCleanup = async (): Promise<TaskCleanupResult | undefined> => {
        if (cleanupCompleted) return undefined;
        const result = await cleanupTask(task, latestExecution?.toolEvidence ?? [], this.runtime.managedProcesses);
        task.cleanup = result.cleanup;
        await this.taskRunStore?.recordCleanup(options.runId, result.cleanup, result.evidence);
        await updateTaskPlan({ taskType: task.taskType, cleanup: result.cleanup });
        cleanupCompleted = true;
        return result;
      };
      const verifier = new AcceptanceVerifier({
        workspaceRoot: this.runtime.workspaceRoot,
        ignore: this.runtime.config.workspace.ignore,
        managedProcesses: this.runtime.managedProcesses
      });
      const executor = new AgentAttemptExecutor({
        agent: this.runtime.agent,
        initialEvidence: resolved.priorToolEvidence,
        runOptions: (context) => ({
          abortSignal: context.signal,
          confirmPermission: async (request) => await options.confirmPermission(request),
          mode: options.mode,
          attachments: options.attachments,
          maxSteps: context.remainingRuntimeSteps === undefined
            ? undefined
            : Math.min(this.runtime.config.agent.maxSteps, context.remainingRuntimeSteps),
          deferSuccessfulMemory: true
        }),
        onEvent: (event) => {
          reasoningActive = options.onAgentEvent(event);
        }
      });
      const loop = new TaskAttemptLoop<TaskContract>({
        budget,
        execute: async (context) => {
          await this.taskRunStore?.startAttempt(options.runId, {
            attemptId: context.attemptId,
            attemptNumber: context.attemptNumber,
            feedback: context.feedback
          });
          let execution: AgentAttemptExecution;
          try {
            execution = await executor.execute(context);
          } catch (error) {
            await this.taskRunStore?.completeAttempt(options.runId, context.attemptId, {
              status: context.signal?.aborted ? "aborted" : "failed",
              runtimeSteps: 0,
              stopReason: context.signal?.aborted ? "aborted" : "provider_error",
              error: errorMessage(error)
            });
            throw error;
          }
          executions.set(context.attemptId, execution);
          latestExecution = execution;
          await this.taskRunStore?.completeAttempt(options.runId, context.attemptId, {
            status: execution.outcomeStatus,
            output: execution.output,
            runtimeSteps: execution.runtimeSteps,
            usage: execution.usage,
            stopReason: execution.stopReason,
            finishReason: execution.finishReason,
            error: execution.error,
            toolEvidence: execution.attemptToolEvidence
          });
          await updateTaskPlan({
            taskType: task.taskType,
            attemptId: context.attemptId,
            execution
          });
          if (reasoningActive) {
            options.onReasoningCompleted();
            reasoningActive = false;
          }
          return {
            output: execution.output,
            runtimeSteps: execution.runtimeSteps,
            usage: execution.usage
          };
        },
        verify: async (context) => {
          const execution = executions.get(context.attemptId);
          if (!execution) return { passed: false, summary: "Attempt execution evidence is unavailable." };
          const result = await verifier.verify(task, execution);
          await this.taskRunStore?.recordVerification(options.runId, context.attemptId, result.evidence);
          await updateTaskPlan({
            taskType: task.taskType,
            attemptId: context.attemptId,
            verificationEvidence: result.evidence,
            verificationPassed: result.passed
          });
          const verification = { passed: result.passed, summary: result.summary, details: { evidence: result.evidence } };
          if (result.passed) await finalizeTaskCleanup();
          const terminal = judgeTaskTerminal(task, verification, task.plan, task.cleanup);
          return { passed: terminal.passed, summary: terminal.summary, details: { evidence: result.evidence } };
        },
        decide: (context) => decideTaskAttempt(executions.get(context.attemptId), true),
        feedbackPrompt: (context) => continuationFeedback(context.verification.summary, context.task)
      });
      const harness = await loop.run(task, options.signal, options.runId);
      const terminalCleanup = await finalizeTaskCleanup();
      const settledHarness = terminalCleanup?.passed === false
        ? { ...harness, status: "failed" as const, terminalReason: terminalCleanup.summary }
        : harness;
      const turn = harnessTurnOutcome(settledHarness, latestExecution, aggregateAttemptUsage([...executions.values()]));
      await this.persistTaskHarnessResult(options.runId, settledHarness, task);
      return { turn };
    } catch (error) {
      if (durableTaskCreated) {
        await this.finishUnsettledTaskRun(
          options.runId,
          options.signal.aborted ? "aborted" : "failed",
          options.signal.aborted ? "Current turn interrupted." : errorMessage(error)
        );
      }
      throw error;
    }
  }

  private async executeCompatibility(options: TaskRunCoordinatorExecution): Promise<TaskRunCoordinatorResult> {
    const contract = compileTaskContract({
      objective: options.input,
      taskType: "conversation",
      acceptanceCriteria: [],
      verificationMode: "model_only"
    });
    let latest: AgentAttemptExecution | undefined;
    let reasoningActive = false;
    const executor = new AgentAttemptExecutor({
      agent: this.runtime.agent,
      runOptions: (context) => ({
        abortSignal: context.signal,
        confirmPermission: async (request) => await options.confirmPermission(request),
        mode: options.mode,
        attachments: options.attachments,
        deferSuccessfulMemory: true
      }),
      prompt: () => options.input,
      onEvent: (event) => {
        reasoningActive = options.onAgentEvent(event);
      }
    });
    const harness = await new TaskAttemptLoop<TaskContract>({
      budget: { maxAttempts: 1 },
      execute: async (context) => {
        latest = await executor.execute(context);
        return { output: latest.output, runtimeSteps: latest.runtimeSteps ?? 0, usage: latest.usage };
      },
      verify: async () => ({
        passed: latest?.outcomeStatus === "completed",
        summary: latest?.outcomeStatus === "completed" ? "Agent completed." : latest?.error ?? "Agent did not complete."
      })
    }).run(contract, options.signal, options.runId);
    if (reasoningActive) options.onReasoningCompleted();
    const settledHarness = harness.status === "budget_exhausted" && (latest?.outcomeStatus !== "completed" || harness.attempts.at(-1)?.error)
      ? {
        ...harness,
        status: "failed" as const,
        terminalReason: latest?.error ?? harness.attempts.at(-1)?.error ?? harness.terminalReason
      }
      : harness;
    return { turn: harnessTurnOutcome(settledHarness, latest, latest?.usage) };
  }

  private async persistTaskHarnessResult(taskRunId: string, result: TaskHarnessRunResult, task: TaskContract): Promise<void> {
    if (!this.taskRunStore) return;
    if (result.status === "passed") {
      task.pendingTodo = [];
      await this.taskRunStore.updateContract(taskRunId, task);
      await this.taskRunStore.finish(taskRunId, "completed", result.terminalReason);
      return;
    }
    if (result.status === "budget_exhausted") {
      const snapshot = await this.taskRunStore.get(taskRunId);
      const verifierTodo = snapshot.attempts.at(-1)?.verifierEvidence
        .filter((evidence) => !evidence.passed)
        .map((evidence) => evidence.summary) ?? [];
      const planTodo = task.plan
        .filter((item) => item.required && item.status !== "completed" && item.status !== "skipped")
        .map((item) => `${item.description} (${item.status})`);
      const cleanupTodo = task.cleanup.status === "failed"
        ? [task.cleanup.summary ?? "Task cleanup failed."]
        : [];
      task.pendingTodo = [...new Set([...verifierTodo, ...planTodo, ...cleanupTodo])];
      await this.taskRunStore.updateContract(taskRunId, task);
      await this.taskRunStore.finish(taskRunId, "budget_exhausted", result.terminalReason);
      return;
    }
    await this.taskRunStore.finish(taskRunId, result.status === "aborted" ? "aborted" : "failed", result.terminalReason);
  }

  private async finishUnsettledTaskRun(
    taskRunId: string,
    status: "failed" | "aborted",
    reason: string
  ): Promise<void> {
    if (!this.taskRunStore) return;
    try {
      const snapshot = await this.taskRunStore.get(taskRunId);
      if (snapshot.status === "queued" || snapshot.status === "running" || snapshot.status === "continuable") {
        await this.taskRunStore.finish(taskRunId, status, reason);
      }
    } catch {
      // Preserve the original run failure when durable cleanup itself is unavailable.
    }
  }
}

function isDurableRuntime(runtime: CommandRuntime): boolean {
  const candidate = runtime as unknown as Record<string, unknown>;
  return typeof candidate.workspaceRoot === "string"
    && typeof candidate.config === "object"
    && candidate.config !== null
    && candidate.managedProcesses !== undefined;
}

async function resolveTaskContract(
  workspaceRoot: string,
  input: string,
  mode: AgentRunMode,
  store: TaskRunStore | undefined,
  ignore: string[]
): Promise<{ contract: TaskContract; priorToolEvidence: TaskToolEvidence[] }> {
  if (mode === "plan") {
    return {
      contract: compileTaskContract({
        objective: input,
        taskType: "conversation",
        acceptanceCriteria: [],
        verificationMode: "model_only",
        constraints: ["Return a concrete execution plan without modifying the workspace."]
      }),
      priorToolEvidence: []
    };
  }
  const inferred = await createTaskContract(workspaceRoot, input, ignore);
  if (!store || !isContinuationRequest(input)) return { contract: inferred, priorToolEvidence: [] };
  const previous = (await store.list()).find((snapshot) =>
    snapshot.status === "continuable" || snapshot.status === "budget_exhausted"
  );
  if (!previous) return { contract: inferred, priorToolEvidence: [] };
  const contract = cloneTaskContract(previous.contract);
  contract.objective = `${contract.objective}\n\nCurrent user request: ${input}`;
  return {
    contract,
    priorToolEvidence: previous.attempts.flatMap((attempt) => attempt.toolEvidence)
  };
}

function cloneTaskContract(contract: TaskContract): TaskContract {
  return {
    ...contract,
    constraints: [...contract.constraints],
    artifacts: [...contract.artifacts],
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    plan: contract.plan.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
    cleanup: {
      ...contract.cleanup,
      processIds: [...contract.cleanup.processIds],
      evidenceIds: [...contract.cleanup.evidenceIds]
    },
    pendingTodo: [...contract.pendingTodo]
  };
}

function isContinuationRequest(input: string): boolean {
  return /(?:^|\s)(?:继续|接着|完成了吗|怎么样了|启动了吗|启动起来了吗)(?:\s|[？?。！!]|$)|\b(?:continue|resume|is it (?:done|running)|did it finish)\b/iu.test(input.trim());
}

function taskBudget(runtime: CommandRuntime): TaskAttemptBudget {
  const agent = runtime.config.agent;
  return {
    maxAttempts: agent.maxAttempts ?? 1,
    maxRuntimeSteps: agent.maxTaskSteps ?? agent.maxSteps ?? 32,
    maxWallTimeMs: agent.maxWallTimeMs,
    maxTotalTokens: agent.maxTotalTokens,
    maxCostUsd: agent.maxCostUsd
  };
}

function continuationFeedback(summary: string, task: TaskContract): string {
  const pending = task.pendingTodo.length ? ` Remaining durable TODO: ${task.pendingTodo.join("; ")}.` : "";
  return `Verification did not accept the previous attempt: ${summary}.${pending}`;
}

function harnessTurnOutcome(
  harness: TaskHarnessRunResult,
  latest: AgentAttemptExecution | undefined,
  usage: SessionUsage | undefined
): AgentTurnOutcome {
  const common = {
    finishReason: latest?.finishReason,
    steps: harness.runtimeStepsUsed,
    output: latest?.output ?? "",
    usage
  };
  if (harness.status === "passed") return { status: "completed", stopReason: "model_stop", ...common };
  if (harness.status === "budget_exhausted") {
    return { status: "incomplete", stopReason: "budget_exhausted", ...common, error: harness.terminalReason };
  }
  if (harness.status === "aborted") return { status: "aborted", stopReason: "aborted", ...common, error: harness.terminalReason };
  if (latest?.outcomeStatus === "incomplete") {
    return { status: "incomplete", stopReason: latest.stopReason, ...common, error: latest.error ?? harness.terminalReason };
  }
  return {
    status: "failed",
    stopReason: latest?.outcomeStatus === "failed" ? latest.stopReason : "verification_failed",
    ...common,
    error: harness.terminalReason
  };
}

function aggregateAttemptUsage(attempts: AgentAttemptExecution[]): SessionUsage | undefined {
  const usages = attempts.flatMap((attempt) => attempt.usage ? [attempt.usage] : []);
  const latest = usages.at(-1);
  if (!latest) return undefined;
  const pricingKnown = usages.every((usage) => usage.pricingKnown && usage.costUsd !== undefined);
  return {
    operation: "agent",
    modelAlias: latest.modelAlias,
    provider: latest.provider,
    model: latest.model,
    inputTokens: sumOptional(usages, "inputTokens"),
    outputTokens: sumOptional(usages, "outputTokens"),
    totalTokens: sumTotalTokens(usages),
    reasoningTokens: sumOptional(usages, "reasoningTokens"),
    cacheReadTokens: sumOptional(usages, "cacheReadTokens"),
    cacheWriteTokens: sumOptional(usages, "cacheWriteTokens"),
    costUsd: pricingKnown ? usages.reduce((total, usage) => total + (usage.costUsd ?? 0), 0) : undefined,
    pricingKnown,
    time: latest.time
  };
}

function sumTotalTokens(usages: SessionUsage[]): number | undefined {
  const hasTokenUsage = usages.some((usage) =>
    usage.totalTokens !== undefined || usage.inputTokens !== undefined || usage.outputTokens !== undefined
  );
  if (!hasTokenUsage) return undefined;
  return usages.reduce(
    (total, usage) => total + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
    0
  );
}

function sumOptional(
  usages: SessionUsage[],
  key: "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens"
): number | undefined {
  const values = usages.flatMap((usage) => usage[key] === undefined ? [] : [usage[key]]);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
