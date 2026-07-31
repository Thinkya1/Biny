/**
 * 任务计划的生成与推进。
 *
 * 计划状态一律由证据推导，不采信模型自己写的「已完成」清单：inspect 看有没有成功的只读
 * 工具调用，执行项看有没有对应的写入/启动动作，verify 看验收证据，cleanup 看清理状态。
 */
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
  "move_file",
  // 一条成功的 shell 命令也可能通过重定向、sed/awk、代码生成或构建脚本改文件，
  // 所以算作可能的写入动作；真正有没有改动仍以独立的工作区指纹判定为准。
  "run_command"
]);

/**
 * 生成初始计划：inspect（可选）→ 执行项 → verify → cleanup。
 * 刻意做得短而固定，让执行过程只需按证据更新状态，不需要重新规划。
 */
export function createInitialTaskPlan(taskType: TaskType, verificationMode: TaskVerificationMode): TaskPlanItem[] {
  // 执行项按任务类型换描述和 id：启动服务 / 改代码 / 直接作答。
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

/** 按持久化证据推进计划状态，而不是采信模型写的清单文本。 */
export function advanceTaskPlan(plan: TaskPlanItem[], progress: TaskPlanProgress): TaskPlanItem[] {
  const toolEvidence = progress.toolEvidence ?? progress.execution?.attemptToolEvidence ?? [];
  // 只认「没报错且有结果」的调用：发起了但失败或没拿到结果的不算做过这件事。
  const successfulToolEvidence = toolEvidence.filter((item) => item.error === undefined && item.result !== undefined);
  const now = new Date().toISOString();
  const inspectionIds = successfulToolEvidence
    .filter((item) => inspectionTools.has(item.tool))
    .map((item) => toolEvidenceId(progress.attemptId, item));
  const executionIds = progress.taskType === "launch"
    ? successfulToolEvidence.filter((item) => item.tool === "start_process").map((item) => toolEvidenceId(progress.attemptId, item))
    : progress.taskType === "code_change"
      ? successfulToolEvidence.filter((item) => mutationTools.has(item.tool)).map((item) => toolEvidenceId(progress.attemptId, item))
      : progress.execution?.outcomeStatus === "completed"
        && (progress.execution.stopReason === "completion_gate" || progress.execution.stopReason === "model_stop")
        ? [agentOutcomeEvidenceId(progress.attemptId)]
        : [];
  const verificationEvidence = progress.verificationEvidence ?? [];
  const verificationIds = verificationEvidence.map((item) => verificationEvidenceId(progress.attemptId, item));
  // 没有任何验收证据时不能算通过，所以这里额外要求 length > 0（空数组的 every 恒为 true）。
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

/** 列出还没完成的必做项；skipped 视为已交代过，不算失败。 */
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

// 以下 id 拼装要和 TaskEvidenceCollector 保持一致，否则计划项会引用到不存在的证据。
// attemptId 缺失时退化成不带尝试前缀的形式（轻量任务没有分尝试）。
function toolEvidenceId(attemptId: string | undefined, evidence: TaskToolEvidence): string {
  return attemptId === undefined ? `tool:${evidence.toolCallId}` : `attempt:${attemptId}:tool:${evidence.toolCallId}`;
}

function verificationEvidenceId(attemptId: string | undefined, evidence: AcceptanceEvidence): string {
  return attemptId === undefined ? `verification:${evidence.criterionId}` : `attempt:${attemptId}:verification:${evidence.criterionId}`;
}

function agentOutcomeEvidenceId(attemptId: string | undefined): string {
  return attemptId === undefined ? "agent:outcome" : `attempt:${attemptId}:agent:outcome`;
}
