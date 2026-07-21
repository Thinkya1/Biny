import type { AgentRunOptions, AgentSession } from "../agent/AgentSession.js";
import type { AgentSessionEvent, AgentTurnOutcome } from "../agent/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import type { TaskAttemptContext } from "./TaskAttemptLoop.js";
import type { AgentAttemptExecution, TaskRequest, TaskToolEvidence } from "./types.js";

export interface AgentAttemptExecutorOptions {
  agent: AgentSession;
  runOptions(context: TaskAttemptContext<TaskRequest>): AgentRunOptions;
  initialEvidence?: TaskToolEvidence[];
  onEvent?(event: AgentSessionEvent, context: TaskAttemptContext<TaskRequest>): void;
}

/** Runs one bounded model/tool attempt while retaining evidence across continuations. */
export class AgentAttemptExecutor {
  private readonly accumulatedEvidence: TaskToolEvidence[];

  constructor(private readonly options: AgentAttemptExecutorOptions) {
    this.accumulatedEvidence = [...(options.initialEvidence ?? [])];
  }

  async execute(context: TaskAttemptContext<TaskRequest>): Promise<AgentAttemptExecution> {
    const prompt = attemptPrompt(context);
    const evidence = new Map<string, TaskToolEvidence>();
    let outcome: AgentTurnOutcome | undefined;
    let terminalEvents = 0;
    let streamFailure: string | undefined;

    for await (const event of this.options.agent.runSdk(prompt, this.options.runOptions(context))) {
      this.options.onEvent?.(event, context);
      if (event.type === "tool-started") {
        evidence.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: compactEvidenceValue(event.args),
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "sdk" && event.part.type === "tool-result") {
        const current = evidence.get(event.part.toolCallId);
        evidence.set(event.part.toolCallId, {
          toolCallId: event.part.toolCallId,
          tool: event.part.toolName,
          args: current?.args,
          result: compactEvidenceValue(event.part.output),
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "sdk" && event.part.type === "tool-error") {
        const current = evidence.get(event.part.toolCallId);
        evidence.set(event.part.toolCallId, {
          toolCallId: event.part.toolCallId,
          tool: event.part.toolName,
          args: current?.args,
          error: String(event.part.error),
          observedAt: new Date().toISOString()
        });
      } else if (event.type === "error" && event.fatal !== false) {
        streamFailure = redactSecrets(event.message);
      } else if (event.type === "done") {
        terminalEvents += 1;
        outcome = event.outcome ?? {
          status: "completed",
          stopReason: "model_stop",
          finishReason: "stop",
          steps: 1,
          output: event.content,
          usage: event.usage
        };
      }
    }

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
      outcomeStatus: outcome.status,
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

function attemptPrompt(context: TaskAttemptContext<TaskRequest>): string {
  if (context.attemptNumber === 1) return context.task.objective;
  const criteria = context.task.acceptanceCriteria.map((criterion) => `- ${criterion.description ?? criterion.id}`).join("\n");
  const feedback = context.feedback ?? "The previous bounded attempt did not reach verified completion.";
  return [
    "Continue the same project-level task autonomously.",
    "Do not ask the user to say continue, and do not repeat work already proven successful.",
    `Original objective: ${context.task.objective}`,
    `Previous attempt feedback: ${feedback}`,
    criteria ? `Acceptance criteria still apply:\n${criteria}` : "Reach a genuine terminal result before stopping.",
    "Inspect current workspace and managed-process state, complete the remaining work, and verify it."
  ].join("\n\n");
}
