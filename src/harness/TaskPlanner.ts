import type {
  AcceptanceEvidence,
  AgentAttemptExecution,
  TaskPlanItem,
  TaskPlanStatus,
  TaskType,
  TaskVerificationMode,
  TaskCleanupPlan,
  TaskToolEvidence
} from "./types.js";

const inspectionTools = new Set([
  "read_file",
  "list_files",
  "search_files",
  "grep_search",
  "git_status",
  "git_diff"
]);
const mutationTools = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "move_file"
]);

/** Creates a small, stable plan that task execution can update from evidence. */
export function createInitialTaskPlan(taskType: TaskType, verificationMode: TaskVerificationMode): TaskPlanItem[] {
  const execute = taskType === "launch"
    ? { id: "start", description: "Start and configure the required managed services.", required: true }
    : taskType === "code_change"
      ? { id: "implement", description: "Implement the requested workspace changes.", required: true }
      : { id: "respond", description: "Produce the requested answer or analysis.", required: true };
  return [
    {
      id: "inspect",
      description: "Inspect the relevant workspace state.",
      required: false,
      status: "pending",
      evidenceIds: [],
      updatedAt: undefined
    },
    { ...execute, status: "pending", evidenceIds: [], updatedAt: undefined },
    {
      id: "verify",
      description: verificationMode === "deterministic"
        ? "Pass every independent acceptance check."
        : "Reach a terminal model response.",
      required: true,
      status: "pending",
      evidenceIds: [],
      updatedAt: undefined
    },
    {
      id: "cleanup",
      description: "Record or perform task-owned process cleanup.",
      required: true,
      status: "pending",
      evidenceIds: [],
      updatedAt: undefined
    }
  ];
}

export interface TaskPlanProgress {
  taskType: TaskType;
  attemptId?: string;
  execution?: AgentAttemptExecution;
  toolEvidence?: TaskToolEvidence[];
  verificationEvidence?: AcceptanceEvidence[];
  verificationPassed?: boolean;
  cleanup?: TaskCleanupPlan;
}

/** Derives plan state from durable evidence rather than model-written checklist prose. */
export function advanceTaskPlan(plan: TaskPlanItem[], progress: TaskPlanProgress): TaskPlanItem[] {
  const toolEvidence = progress.toolEvidence ?? progress.execution?.attemptToolEvidence ?? [];
  const successfulToolEvidence = toolEvidence.filter((item) => item.error === undefined && item.result !== undefined);
  const now = new Date().toISOString();
  const inspectionIds = successfulToolEvidence
    .filter((item) => inspectionTools.has(item.tool))
    .map((item) => toolEvidenceId(progress.attemptId, item));
  const executionIds = progress.taskType === "launch"
    ? successfulToolEvidence.filter((item) => item.tool === "start_process").map((item) => toolEvidenceId(progress.attemptId, item))
    : progress.taskType === "code_change"
      ? successfulToolEvidence.filter((item) => mutationTools.has(item.tool)).map((item) => toolEvidenceId(progress.attemptId, item))
      : progress.execution?.outcomeStatus === "completed" && progress.execution.stopReason === "model_stop"
        ? [agentOutcomeEvidenceId(progress.attemptId)]
        : [];
  const verificationEvidence = progress.verificationEvidence ?? [];
  const verificationIds = verificationEvidence.map((item) => verificationEvidenceId(progress.attemptId, item));
  const verificationPassed = progress.verificationPassed === true
    || verificationEvidence.length > 0 && verificationEvidence.every((item) => item.passed);
  const verificationFailed = progress.verificationPassed === false || verificationEvidence.some((item) => !item.passed);

  return plan.map((item) => {
    if (item.id === "inspect" && inspectionIds.length) return update(item, "completed", inspectionIds, now);
    if ((item.id === "implement" || item.id === "start" || item.id === "respond") && executionIds.length) {
      return update(item, "completed", executionIds, now);
    }
    if (item.id === "verify") {
      if (verificationPassed) return update(item, "completed", verificationIds, now);
      if (verificationFailed) return update(item, "blocked", verificationIds, now);
      if (progress.execution) return update(item, "in_progress", [], now);
    }
    if (item.id === "cleanup" && progress.cleanup) {
      const status: TaskPlanStatus = progress.cleanup.status === "failed"
        ? "blocked"
        : progress.cleanup.status === "pending"
          ? "in_progress"
          : "completed";
      return update(item, status, progress.cleanup.evidenceIds, now);
    }
    return item;
  });
}

export function requiredPlanFailures(plan: TaskPlanItem[]): TaskPlanItem[] {
  return plan.filter((item) => item.required && item.status !== "completed" && item.status !== "skipped");
}

function update(item: TaskPlanItem, status: TaskPlanStatus, evidenceIds: string[], updatedAt: string): TaskPlanItem {
  return {
    ...item,
    status,
    evidenceIds: [...new Set([...item.evidenceIds, ...evidenceIds])],
    updatedAt
  };
}

function toolEvidenceId(attemptId: string | undefined, evidence: TaskToolEvidence): string {
  return attemptId === undefined ? `tool:${evidence.toolCallId}` : `attempt:${attemptId}:tool:${evidence.toolCallId}`;
}

function verificationEvidenceId(attemptId: string | undefined, evidence: AcceptanceEvidence): string {
  return attemptId === undefined ? `verification:${evidence.criterionId}` : `attempt:${attemptId}:verification:${evidence.criterionId}`;
}

function agentOutcomeEvidenceId(attemptId: string | undefined): string {
  return attemptId === undefined ? "agent:outcome" : `attempt:${attemptId}:agent:outcome`;
}
