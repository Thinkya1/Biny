/**
 * 普通 Agent 回合的完成门。
 *
 * Provider 只负责结束一次响应；这里根据 Todo、结构化工具事实、预算、阻塞状态和独立验证，
 * 决定整个用户回合是否真的可以结束。所有 continuation 都是内部 system 消息，不会伪装成
 * 新的用户输入。
 */
import { createHash } from "node:crypto";
import type { ModelMessage } from "./core/modelMessage.js";
import type { TodoItem } from "../session/todoStore.js";
import type { AgentToolEvent } from "./types.js";

interface AgentLoopToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type BlockedReason =
  | "missing_user_input"
  | "waiting_for_approval"
  | "permission_denied"
  | "missing_dependency"
  | "environment_unavailable"
  | "external_service_failure"
  | "unsafe_action_required";

export interface BlockedState {
  reason: BlockedReason;
  summary: string;
  requiredAction?: string;
  affectedTodoIds?: string[];
}

export interface CommandFact {
  toolCallId: string;
  command: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
}

export interface ToolFailureFact {
  toolCallId: string;
  tool: string;
  error: string;
  result?: unknown;
  /** 只保存不可逆摘要；同一动作后续成功时才能消解这条失败。 */
  actionFingerprint?: string;
  /** 参数校验失败可由同一工具后续任意一次合法成功调用修复。 */
  validationFailure?: boolean;
}

export interface ProcessFact {
  processId: string;
  state: string;
  command?: string;
  cwd?: string;
  url?: string;
  readiness?: unknown;
}

export interface VerificationEvidenceFact {
  id: string;
  passed: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface VerificationFact {
  passed: boolean;
  summary: string;
  evidence: VerificationEvidenceFact[];
}

export interface RunFacts {
  actualToolCallCount: number;
  /** 至少一个获得可写资源的工具已经进入执行阶段；精确 diff 尚未来得及落盘时仍为 true。 */
  workspaceMutationObserved: boolean;
  /** 宿主显式要求确定性验证；自然语言关键词不会设置该事实。 */
  userRequestedVerification: boolean;
  changedFiles: string[];
  executedCommands: CommandFact[];
  failedToolCalls: ToolFailureFact[];
  pendingApprovals: number;
  activeToolCalls: number;
  activeProcesses: ProcessFact[];
  startedProcessIds: string[];
  verificationResults: VerificationFact[];
  userCancelled: boolean;
  maxRepeatedActionCount: number;
}

export interface StructuredVerificationCheck {
  id: string;
  kind: "command" | "managed_process";
  description: string;
  command?: string;
  cwd?: string;
  processId?: string;
}

export interface CompletionVerification {
  required: boolean;
  checks: StructuredVerificationCheck[];
}

export interface CompletionGateVerifier {
  derive(facts: RunFacts, requestedChecks: readonly StructuredVerificationCheck[]): Promise<CompletionVerification>;
  verify(requirement: CompletionVerification, signal?: AbortSignal): Promise<VerificationFact>;
}

export interface CompletionBudgetSnapshot {
  steps: number;
  softStepLimit: number;
  hardStepLimit: number;
  maxToolCalls: number;
  maxCompletionContinuations: number;
  maxRepeatedActions: number;
}

export type IncompleteReason =
  | "hard_step_limit"
  | "tool_call_limit"
  | "completion_continuation_limit"
  | "no_progress_after_continuation"
  | "repeated_action_limit"
  | "model_output_limit";

export type CompletionDecision =
  | { kind: "complete" }
  | { kind: "continue"; feedback: ModelMessage }
  | {
      kind: "blocked";
      reason: BlockedReason;
      summary: string;
      requiredAction?: string;
      affectedTodoIds?: string[];
    }
  | { kind: "incomplete"; reason: IncompleteReason; summary: string; resumable: boolean }
  | { kind: "cancelled" };

export interface CompletionProgressState {
  attempts: number;
  stagnantAttempts: number;
  previousTodoFingerprint: string;
  previousFactsFingerprint: string;
}

export interface CompletionGateOptions {
  verifier: CompletionGateVerifier;
  listTodos(): TodoItem[];
  listRequestedChecks(): StructuredVerificationCheck[];
  blockedState(): BlockedState | undefined;
  onVerification?(result: VerificationFact): void;
}

interface PendingToolFact {
  tool: string;
  args: unknown;
}

interface ObservedToolFailure {
  fact: ToolFailureFact;
  actionFingerprint: string;
}

/** 同一回合内只追加事实，不从模型文本或日志猜测状态。 */
export class RunFactsCollector {
  private actualToolCallCount = 0;
  private workspaceMutationObserved = false;
  private userRequestedVerification = false;
  private readonly changedFiles = new Set<string>();
  private readonly commands = new Map<string, CommandFact>();
  private readonly failures = new Map<string, ObservedToolFailure>();
  private readonly activeTools = new Map<string, PendingToolFact>();
  private readonly actionCounts = new Map<string, number>();
  private readonly processes = new Map<string, ProcessFact>();
  private readonly startedProcessIds = new Set<string>();
  private readonly verificationResults: VerificationFact[] = [];
  private pendingApprovals = 0;

  constructor(initial?: RunFacts) {
    if (!initial) return;
    this.actualToolCallCount = initial.actualToolCallCount;
    // 版本升级前的断点没有该字段；恢复时按 false 兼容，新的可写 admission 会重新置 true。
    this.workspaceMutationObserved = initial.workspaceMutationObserved === true;
    this.userRequestedVerification = initial.userRequestedVerification === true;
    for (const file of initial.changedFiles) this.changedFiles.add(file);
    for (const command of initial.executedCommands) {
      this.commands.set(command.toolCallId, { ...command });
    }
    for (const failure of initial.failedToolCalls) {
      // 旧断点没有动作摘要时使用本次调用的唯一占位，避免一次无关成功把历史失败抹掉。
      const actionFingerprint = failure.actionFingerprint ?? `restored:${failure.toolCallId}`;
      const validationFailure = failure.validationFailure === true
        || readBoolean(failure.result, "validation") === true;
      this.failures.set(failure.toolCallId, {
        fact: { ...failure, actionFingerprint, validationFailure },
        actionFingerprint
      });
    }
    for (const process of initial.activeProcesses) {
      this.processes.set(process.processId, { ...process });
    }
    for (const processId of initial.startedProcessIds) this.startedProcessIds.add(processId);
    for (const verification of initial.verificationResults) this.recordVerification(verification);
    this.pendingApprovals = initial.pendingApprovals;
    if (initial.maxRepeatedActionCount > 0) {
      this.actionCounts.set("__restored_maximum__", initial.maxRepeatedActionCount);
    }
  }

  observeActualToolCalls(calls: readonly AgentLoopToolCall[]): void {
    this.actualToolCallCount += calls.length;
    const restoredMaximum = this.actionCounts.get("__restored_maximum__");
    if (restoredMaximum !== undefined && calls.length > 0) {
      this.actionCounts.set("__restored_maximum__", restoredMaximum + calls.length);
    }
    for (const call of calls) {
      const fingerprint = `${call.toolName}\0${stableValue(call.input)}`;
      this.actionCounts.set(fingerprint, (this.actionCounts.get(fingerprint) ?? 0) + 1);
    }
  }

  observeToolEvent(event: AgentToolEvent): void {
    if (event.type === "tool.started") {
      this.activeTools.set(event.toolCallId, { tool: event.tool, args: event.args });
      if (event.tool === "run_command" || event.tool === "start_process") {
        this.commands.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          command: readString(event.args, "command") ?? event.description ?? event.tool,
          cwd: readString(event.args, "cwd")
        });
      }
      return;
    }
    if (event.type === "tool.progress") return;
    const pending = this.activeTools.get(event.toolCallId);
    this.activeTools.delete(event.toolCallId);
    if (event.type === "tool.failed") {
      const actionFingerprint = pending
        ? toolActionFingerprint(pending.tool, pending.args)
        : `unmatched:${event.toolCallId}`;
      const validationFailure = readBoolean(event.result, "validation") === true;
      this.failures.set(event.toolCallId, {
        fact: {
          toolCallId: event.toolCallId,
          tool: event.tool,
          error: event.error,
          result: event.result,
          actionFingerprint,
          validationFailure
        },
        actionFingerprint
      });
      this.finishCommand(event.toolCallId, event.result);
      return;
    }
    this.failures.delete(event.toolCallId);
    if (pending) {
      const actionFingerprint = toolActionFingerprint(pending.tool, pending.args);
      for (const [toolCallId, failure] of this.failures) {
        if (
          failure.actionFingerprint === actionFingerprint
          || failure.fact.validationFailure === true && failure.fact.tool === pending.tool
        ) {
          this.failures.delete(toolCallId);
        }
      }
    }
    this.finishCommand(event.toolCallId, event.result);
    if (event.tool === "start_process") {
      const processId = readString(event.result, "processId");
      if (processId) {
        this.startedProcessIds.add(processId);
        this.processes.set(processId, processFact(event.result, processId));
      }
    }
    if (pending && mutatesKnownFile(event.tool)) {
      for (const filePath of changedPaths(pending.args, event.result)) this.changedFiles.add(filePath);
    }
  }

  setChangedFiles(files: readonly string[]): void {
    for (const file of files) this.changedFiles.add(file);
  }

  markWorkspaceMutationObserved(): void {
    this.workspaceMutationObserved = true;
  }

  setUserRequestedVerification(required: boolean): void {
    this.userRequestedVerification = required;
  }

  setPendingApprovals(count: number): void {
    this.pendingApprovals = Math.max(0, count);
  }

  setActiveProcesses(processes: readonly ProcessFact[]): void {
    this.processes.clear();
    for (const process of processes) this.processes.set(process.processId, { ...process });
  }

  recordVerification(result: VerificationFact): void {
    const recorded = {
      ...result,
      evidence: result.evidence.map((evidence) => ({ ...evidence }))
    };
    const previous = this.verificationResults.at(-1);
    // 同一个失败结果被完成门再次确认，不算新的进展；否则会绕过无进展保护。
    if (previous && stableValue(previous) === stableValue(recorded)) return;
    this.verificationResults.push(recorded);
  }

  snapshot(userCancelled: boolean): RunFacts {
    const startedProcessIds = [...this.startedProcessIds];
    const activeStartedProcessIds = startedProcessIds.filter((processId) => {
      const state = this.processes.get(processId)?.state;
      return state === "starting" || state === "running" || state === "ready";
    });
    return {
      actualToolCallCount: this.actualToolCallCount,
      workspaceMutationObserved: this.workspaceMutationObserved,
      userRequestedVerification: this.userRequestedVerification,
      changedFiles: [...this.changedFiles].sort(),
      executedCommands: [...this.commands.values()].map((command) => ({ ...command })),
      failedToolCalls: [...this.failures.values()]
        .map((failure) => ({ ...failure.fact })),
      pendingApprovals: this.pendingApprovals,
      activeToolCalls: this.activeTools.size,
      activeProcesses: [...this.processes.values()].map((process) => ({ ...process })),
      // 健康替代进程启动后，不让已经停止的旧实例永久阻塞；如果一个活跃实例都没有，
      // 仍保留最后一次启动，让 Verifier 对“启动后立刻退出”给出失败证据。
      startedProcessIds: (activeStartedProcessIds.length
        ? activeStartedProcessIds
        : startedProcessIds.slice(-1)).sort(),
      verificationResults: this.verificationResults.map((result) => ({
        ...result,
        evidence: result.evidence.map((evidence) => ({ ...evidence }))
      })),
      userCancelled,
      maxRepeatedActionCount: Math.max(0, ...this.actionCounts.values())
    };
  }

  private finishCommand(toolCallId: string, result: unknown): void {
    const command = this.commands.get(toolCallId);
    if (!command) return;
    command.status = readString(result, "status");
    command.exitCode = readNumber(result, "exitCode");
  }
}

export class CompletionGate {
  private readonly progress: CompletionProgressState = {
    attempts: 0,
    stagnantAttempts: 0,
    previousTodoFingerprint: "",
    previousFactsFingerprint: ""
  };
  private lastVerificationInput = "";
  private lastVerification: VerificationFact | undefined;

  constructor(private readonly options: CompletionGateOptions) {}

  async decide(
    facts: RunFacts,
    budget: CompletionBudgetSnapshot,
    signal?: AbortSignal
  ): Promise<CompletionDecision> {
    if (facts.userCancelled || signal?.aborted) return { kind: "cancelled" };
    if (facts.pendingApprovals > 0) {
      return {
        kind: "blocked",
        reason: "waiting_for_approval",
        summary: "A tool approval is still pending.",
        requiredAction: "Approve or reject the pending tool request."
      };
    }
    const explicitBlocked = this.options.blockedState() ?? blockedFromFailures(facts.failedToolCalls);
    if (explicitBlocked) return { kind: "blocked", ...explicitBlocked };
    if (facts.activeToolCalls > 0) {
      return this.continueOrStop(
        "Foreground tool execution is still active. Wait for its structured result before finishing.",
        facts,
        budget
      );
    }
    if (budget.steps >= budget.hardStepLimit) {
      return {
        kind: "incomplete",
        reason: "hard_step_limit",
        summary: `The run reached its hard limit of ${String(budget.hardStepLimit)} provider steps.`,
        resumable: true
      };
    }
    if (facts.actualToolCallCount >= budget.maxToolCalls) {
      return {
        kind: "incomplete",
        reason: "tool_call_limit",
        summary: `The run reached its limit of ${String(budget.maxToolCalls)} tool calls.`,
        resumable: true
      };
    }
    if (facts.maxRepeatedActionCount >= budget.maxRepeatedActions) {
      return {
        kind: "incomplete",
        reason: "repeated_action_limit",
        summary: "The same structured tool action was repeated too many times.",
        resumable: true
      };
    }

    const remainingTodos = this.options.listTodos().filter((todo) => todo.status !== "completed");
    if (remainingTodos.length > 0) {
      return this.continueOrStop(
        `The plan still has unfinished items: ${remainingTodos.map((todo) => `[${todo.status}] ${todo.content}`).join("; ")}`,
        facts,
        budget
      );
    }
    if (facts.failedToolCalls.length > 0) {
      return this.continueOrStop(
        `Tool failures still need resolution: ${facts.failedToolCalls.map((failure) => `${failure.tool}: ${failure.error}`).join("; ")}`,
        facts,
        budget
      );
    }

    const requestedChecks = this.options.listRequestedChecks();
    const requirement = await this.options.verifier.derive(facts, requestedChecks);
    if (requirement.required) {
      const verificationInput = stableValue({
        changedFiles: facts.changedFiles,
        startedProcessIds: facts.startedProcessIds,
        checks: requirement.checks
      });
      let verification = this.lastVerification;
      // 失败只说明上一次代码状态未通过。continuation 修复后必须独立重跑，不能复用失败结论。
      if (!verification?.passed || verificationInput !== this.lastVerificationInput) {
        verification = await this.options.verifier.verify(requirement, signal);
        this.lastVerificationInput = verificationInput;
        this.lastVerification = verification;
        this.options.onVerification?.(verification);
      }
      if (!verification.passed) {
        return this.continueOrStop(
          verificationFailureFeedback(verification),
          facts,
          budget
        );
      }
    }
    return { kind: "complete" };
  }

  private continueOrStop(
    feedback: string,
    facts: RunFacts,
    budget: CompletionBudgetSnapshot
  ): CompletionDecision {
    const todos = this.options.listTodos();
    const todoFingerprint = stableValue(todos);
    const factsFingerprint = progressFactsFingerprint(facts);
    if (
      this.progress.previousTodoFingerprint
      && todoFingerprint === this.progress.previousTodoFingerprint
      && factsFingerprint === this.progress.previousFactsFingerprint
    ) {
      this.progress.stagnantAttempts += 1;
    } else {
      this.progress.stagnantAttempts = 0;
    }
    this.progress.attempts += 1;
    this.progress.previousTodoFingerprint = todoFingerprint;
    this.progress.previousFactsFingerprint = factsFingerprint;

    if (this.progress.stagnantAttempts >= budget.maxRepeatedActions) {
      return {
        kind: "incomplete",
        reason: "no_progress_after_continuation",
        summary: "Completion continuations produced no structured progress.",
        resumable: true
      };
    }
    if (this.progress.attempts > budget.maxCompletionContinuations) {
      return {
        kind: "incomplete",
        reason: "completion_continuation_limit",
        summary: `The completion gate reached its limit of ${String(budget.maxCompletionContinuations)} continuations.`,
        resumable: true
      };
    }
    return {
      kind: "continue",
      feedback: {
        role: "system",
        content: [
          "## Biny completion gate",
          "",
          feedback,
          "Continue the same user task now. Do not claim completion until the structured facts above are resolved."
        ].join("\n")
      }
    };
  }
}

function verificationFailureFeedback(verification: VerificationFact): string {
  const failures = verification.evidence.filter((evidence) => !evidence.passed);
  const evidence = failures.map((item) => {
    const details = item.details === undefined ? "" : `\n  details: ${stableValue(item.details)}`;
    return `- ${item.id}: ${item.summary}${details}`;
  });
  return [
    `Independent verification failed: ${verification.summary}`,
    ...(evidence.length ? ["Evidence:", ...evidence] : [])
  ].join("\n");
}

function blockedFromFailures(failures: readonly ToolFailureFact[]): BlockedState | undefined {
  const permission = failures.find((failure) => {
    const status = readString(failure.result, "status");
    return status === "denied" || status === "permission_required" || readBoolean(failure.result, "approved") === false;
  });
  if (!permission) return undefined;
  return {
    reason: "permission_denied",
    summary: permission.error,
    requiredAction: "Approve the required action or change the request so it can proceed safely."
  };
}

function progressFactsFingerprint(facts: RunFacts): string {
  return stableValue({
    actualToolCallCount: facts.actualToolCallCount,
    workspaceMutationObserved: facts.workspaceMutationObserved,
    userRequestedVerification: facts.userRequestedVerification,
    changedFiles: facts.changedFiles,
    commands: facts.executedCommands,
    failures: facts.failedToolCalls.map(({ toolCallId, tool, error }) => ({ toolCallId, tool, error })),
    pendingApprovals: facts.pendingApprovals,
    activeToolCalls: facts.activeToolCalls,
    processes: facts.activeProcesses,
    verifications: facts.verificationResults.map(({ passed, summary }) => ({ passed, summary }))
  });
}

function mutatesKnownFile(tool: string): boolean {
  return tool === "write_file"
    || tool === "edit_file"
    || tool === "multi_edit"
    || tool === "apply_patch"
    || tool === "delete_file"
    || tool === "move_file";
}

function changedPaths(args: unknown, result: unknown): string[] {
  const values = [
    readString(args, "path"),
    readString(args, "from"),
    readString(args, "to"),
    readString(result, "path"),
    readString(result, "from"),
    readString(result, "to")
  ];
  if (isRecord(args) && Array.isArray(args.edits)) {
    for (const edit of args.edits) values.push(readString(edit, "path"));
  }
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function processFact(value: unknown, processId: string): ProcessFact {
  return {
    processId,
    state: readString(value, "state") ?? "unknown",
    command: readString(value, "command"),
    cwd: readString(value, "cwd"),
    url: readString(value, "url"),
    readiness: isRecord(value) ? value.readiness : undefined
  };
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function toolActionFingerprint(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(stableValue(args))
    .digest("hex");
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
