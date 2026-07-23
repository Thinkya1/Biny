import type {
  AcceptanceCriterion,
  TaskCleanupPolicy,
  TaskContract,
  TaskType,
  TaskVerificationMode
} from "./types.js";
import { createInitialTaskPlan } from "./TaskPlanner.js";

export interface TaskContractInput {
  objective: string;
  taskType: TaskType;
  acceptanceCriteria: AcceptanceCriterion[];
  verificationMode: TaskVerificationMode;
  artifacts?: string[];
  constraints?: string[];
  pendingTodo?: string[];
}

/** Compiles inferred task facts into one durable, machine-checkable contract. */
export function compileTaskContract(input: TaskContractInput): TaskContract {
  const cleanupPolicy = cleanupPolicyFor(input.taskType);
  const artifacts = uniqueNonEmpty(input.artifacts ?? []);
  const constraints = uniqueNonEmpty([
    "Keep all work inside the workspace.",
    "Do not treat model prose as completion.",
    ...(input.verificationMode === "deterministic"
      ? ["Every deterministic acceptance criterion must pass in the independent verifier."]
      : ["A terminal model stop is required before the response can complete."]),
    ...(input.constraints ?? [])
  ]);
  return {
    objective: input.objective,
    taskType: input.taskType,
    constraints,
    artifacts,
    acceptanceCriteria: input.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    verificationMode: input.verificationMode,
    plan: createInitialTaskPlan(input.taskType, input.verificationMode),
    cleanup: {
      policy: cleanupPolicy,
      status: cleanupPolicy === "not_needed" ? "not_needed" : "pending",
      processIds: [],
      evidenceIds: [],
      summary: cleanupPolicy === "not_needed" ? "No task-owned managed-process cleanup is required." : undefined,
      completedAt: undefined
    },
    pendingTodo: uniqueNonEmpty(input.pendingTodo ?? [])
  };
}

function cleanupPolicyFor(taskType: TaskType): TaskCleanupPolicy {
  if (taskType === "launch") return "preserve_task_processes";
  if (taskType === "code_change") return "stop_task_processes";
  return "not_needed";
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
