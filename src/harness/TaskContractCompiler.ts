/**
 * 任务契约编译。
 *
 * 把「目标 + 任务类型 + 验收条件」这些推断出来的事实，编译成一份可机器校验的契约：附上
 * 通用约束、初始计划和清理策略。契约一旦生成就是这次任务的判定依据，因此这里只做确定性
 * 转换，不调用模型。
 */
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

/** 把推断出的任务事实编译成一份持久、可机器校验的契约。 */
export function compileTaskContract(input: TaskContractInput): TaskContract {
  const cleanupPolicy = cleanupPolicyFor(input.taskType);
  const artifacts = uniqueNonEmpty(input.artifacts ?? []);
  // 前两条是所有任务的硬约束（不越界、不把模型的说辞当完成）；后面按验收方式追加，
  // 最后拼上调用方给的额外约束。
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

/**
 * 清理策略按任务类型定：launch 任务的目的就是把进程跑起来，不能收尾时杀掉；
 * code_change 期间起的进程（构建、测试、临时服务）必须停掉；其余任务没有需要清理的进程。
 */
function cleanupPolicyFor(taskType: TaskType): TaskCleanupPolicy {
  if (taskType === "launch") return "preserve_task_processes";
  if (taskType === "code_change") return "stop_task_processes";
  return "not_needed";
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
