/**
 * 单次 Agent 尝试的执行器。
 *
 * 跑一轮受限的模型/工具循环，边跑边把工具调用攒成证据。证据按 toolCallId 存 Map，因为
 * 「开始 / 结果 / 失败」是三个事件，需要后到的补写同一条记录。
 *
 * `accumulatedEvidence` 跨自动续跑保留：验收看的是整段任务的证据，而 `attemptToolEvidence`
 * 只含本次尝试的，用于按尝试审计。
 */
import type { AgentAttemptOptions, AgentSession } from "../agent/AgentSession.js";
import type { AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import type { TaskAttemptContext } from "./TaskAttemptLoop.js";
import type { AgentAttemptExecution, TaskContract, TaskToolEvidence } from "./types.js";

export interface AgentAttemptExecutorOptions {
  agent: AgentSession;
  runOptions(context: TaskAttemptContext<TaskContract>): AgentAttemptOptions;
  prompt?(context: TaskAttemptContext<TaskContract>): string;
  initialEvidence?: TaskToolEvidence[];
  onEvent?(event: AgentSessionEvent, context: TaskAttemptContext<TaskContract>): void;
}

/** 执行一次受限的模型/工具尝试，并跨续跑保留证据。 */
export class AgentAttemptExecutor {
  private readonly accumulatedEvidence: TaskToolEvidence[];

  constructor(private readonly options: AgentAttemptExecutorOptions) {
    this.accumulatedEvidence = [...(options.initialEvidence ?? [])];
  }

  async execute(context: TaskAttemptContext<TaskContract>): Promise<AgentAttemptExecution> {
    const prompt = this.options.prompt?.(context) ?? attemptPrompt(context);
    const evidence = new Map<string, TaskToolEvidence>();
    let outcome: AgentTurnOutcome | undefined;
    let terminalEvents = 0;
    let streamFailure: string | undefined;

    const runOptions = this.options.runOptions(context);
    const publicInput = runOptions.sessionUserMessage ?? prompt;
    // 验收用的提示词属于模型上下文，不是用户看到的消息，因此宿主事件和 session 记录里
    // 用 publicInput，真正发给模型的完整 prompt 走 modelInput（对应 publicUserMessage 的切分）。
    for await (const event of this.options.agent.runAttempt(publicInput, { ...runOptions, modelInput: prompt })) {
      this.options.onEvent?.(event, context);
      if (event.type === "tool.started") {
        evidence.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: compactEvidenceValue(event.args),
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "tool.completed") {
        const current = evidence.get(event.toolCallId);
        evidence.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: current?.args,
          result: compactEvidenceValue(event.result),
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "tool.failed") {
        const current = evidence.get(event.toolCallId);
        evidence.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: current?.args,
          result: event.result === undefined ? undefined : compactEvidenceValue(event.result),
          error: event.error,
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "error" && event.fatal !== false) {
        streamFailure = redactSecrets(event.message);
      } else if (event.type === "done") {
        terminalEvents += 1;
        // 早期嵌入方只发终态文本、不带 outcome。这种形状按「正常收尾」处理，
        // 以便宿主事件测试和轻量集成方仍能配合当前执行器工作。
        outcome = event.outcome ?? {
          status: "completed",
          stopReason: "model_stop",
          steps: 0,
          output: event.content,
          usage: event.usage
        };
      }
    }

    // 一次尝试必须恰好有一个终态事件：一个都没有说明流异常结束，多于一个说明上游有 bug，
    // 两种情况都不能当成完成，否则会把没做完的任务判成通过。
    if (terminalEvents !== 1 || !outcome) {
      const attemptToolEvidence = [...evidence.values()];
      this.accumulatedEvidence.push(...attemptToolEvidence);
      return {
        output: "",
        runtimeSteps: 0,
        outcomeStatus: "failed",
        stopReason: "provider_error",
        finishReason: undefined,
        error: terminalEvents > 1
          ? "Agent stream emitted multiple terminal results."
          : streamFailure ?? "Agent stream ended without a terminal result.",
        attemptToolEvidence,
        toolEvidence: [...this.accumulatedEvidence]
      };
    }

    const attemptToolEvidence = [...evidence.values()];
    this.accumulatedEvidence.push(...attemptToolEvidence);
    return {
      output: outcome.output,
      runtimeSteps: outcome.steps,
      usage: outcome.usage,
      // Durable Attempt 的持久化枚举保持兼容；普通 Loop 的新终态在跨入旧 harness 时降级。
      outcomeStatus: outcome.status === "cancelled"
        ? "aborted"
        : outcome.status === "blocked"
          ? "incomplete"
          : outcome.status,
      stopReason: outcome.stopReason,
      finishReason: outcome.finishReason,
      error: outcome.error,
      attemptToolEvidence,
      toolEvidence: [...this.accumulatedEvidence]
    };
  }
}

const maxEvidenceStringChars = 2_000;
const maxEvidenceValueBytes = 8 * 1024;

/**
 * 证据要落盘，所以工具参数和结果先脱敏再压缩：限制字符串长度、数组/对象条目数和嵌套深度，
 * 整体仍超过字节上限时只留一段预览并标记 truncated。
 */
function compactEvidenceValue(value: unknown): unknown {
  const compact = compactValue(redactSensitiveValue(value), 0);
  const serialized = JSON.stringify(compact);
  if (serialized === undefined) return String(compact);
  if (Buffer.byteLength(serialized, "utf8") <= maxEvidenceValueBytes) return compact;
  return {
    truncated: true,
    preview: Buffer.from(serialized, "utf8").subarray(0, maxEvidenceValueBytes).toString("utf8")
  };
}

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length <= maxEvidenceStringChars ? value : `${value.slice(0, maxEvidenceStringChars - 1)}…`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((item) => compactValue(item, depth + 1));
    if (value.length > items.length) items.push(`[${String(value.length - items.length)} more items]`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 50);
    const result = Object.fromEntries(entries.map(([key, item]) => [key, compactValue(item, depth + 1)]));
    if (Object.keys(value).length > entries.length) result._truncatedKeys = true;
    return result;
  }
  return String(value);
}

/**
 * 拼装本次尝试的提示词。
 *
 * 三种形态：纯对话任务的首次尝试直接用目标原文；验收驱动任务的首次尝试附上契约和验收条件；
 * 续跑则改成「自主继续」的口吻并带上上一次的反馈，避免模型反问用户或重做已完成的部分。
 *
 * 这里的固定前缀/标记同时被 `session/publicMessage.ts` 用来还原用户原始输入，改文案要一起改。
 */
function attemptPrompt(context: TaskAttemptContext<TaskContract>): string {
  if (context.task.verificationMode === "model_only" && context.attemptNumber === 1) {
    return context.task.objective;
  }
  const criteria = context.task.acceptanceCriteria
    .map((criterion) => `- ${JSON.stringify(criterion)}`)
    .join("\n");
  const contract = formatTaskContract(context.task);
  if (context.attemptNumber === 1) {
    return [
      context.task.objective,
      "",
      "This is a verifier-driven task. Complete the objective and satisfy every acceptance criterion below.",
      contract,
      criteria,
      "Do not claim completion until the workspace and the required checks are actually in a passing state."
    ].join("\n");
  }
  const feedback = context.feedback ?? "The previous bounded attempt did not reach verified completion.";
  return [
    "Continue the same project-level task autonomously.",
    "Do not ask the user to say continue, and do not repeat work already proven successful.",
    `Original objective: ${context.task.objective}`,
    `Previous attempt feedback: ${feedback}`,
    contract,
    criteria ? `Acceptance criteria still apply:\n${criteria}` : "Reach a genuine terminal result before stopping.",
    "Inspect current workspace and managed-process state, complete the remaining work, and verify it."
  ].join("\n\n");
}

function formatTaskContract(contract: TaskContract): string {
  const plan = contract.plan
    .map((item) => `- [${item.status}] ${item.description}${item.required ? " (required)" : ""}`)
    .join("\n");
  return [
    `Task contract type: ${contract.taskType}.`,
    `Constraints:\n${contract.constraints.map((constraint) => `- ${constraint}`).join("\n")}`,
    `Current plan:\n${plan}`
  ].join("\n");
}
