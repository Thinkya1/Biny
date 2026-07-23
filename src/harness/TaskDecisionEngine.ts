import type { AgentAttemptExecution, TaskCleanupPlan, TaskContract, TaskPlanItem } from "./types.js";
import type { TaskHarnessDecision, TaskVerification } from "./TaskAttemptLoop.js";
import { requiredPlanFailures } from "./TaskPlanner.js";

export interface TaskTerminalDecision {
  passed: boolean;
  summary: string;
}

/** Keeps retry/stop policy separate from the Agent and verifier loops. */
export function decideTaskAttempt(
  execution: AgentAttemptExecution | undefined,
  hasRuntimeConfig: boolean
): TaskHarnessDecision {
  if (execution?.outcomeStatus === "aborted") return "abort";
  if (execution?.stopReason === "content_filter") return "stop";
  if (!hasRuntimeConfig && execution?.outcomeStatus !== "completed") return "stop";
  return "retry";
}

/** Requires verifier success, completed required plan items, and cleanup proof. */
export function judgeTaskTerminal(
  contract: TaskContract | undefined,
  verification: TaskVerification,
  plan: TaskPlanItem[] | undefined,
  cleanup: TaskCleanupPlan | undefined
): TaskTerminalDecision {
  if (!verification.passed) return { passed: false, summary: verification.summary };
  if (!contract || !plan || !cleanup) return { passed: true, summary: verification.summary };
  const pending = requiredPlanFailures(plan);
  if (pending.length) {
    return {
      passed: false,
      summary: `Required plan items are not complete: ${pending.map((item) => item.description).join("; ")}`
    };
  }
  if (cleanup.status === "failed" || cleanup.status === "pending") {
    return { passed: false, summary: cleanup.summary ?? "Task cleanup is not complete." };
  }
  return { passed: true, summary: verification.summary };
}
