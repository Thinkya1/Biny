/**
 * 任务收尾清理。
 *
 * 只处理「本次任务自己起的」受管进程：进程 id 从契约里已记录的加上工具证据里 start_process
 * 的返回值合并而来，不去碰任务之外的进程。
 *
 * 清理结果本身也要产出证据，因为终局判定要求清理有据可查（见 TaskDecisionEngine）。
 */
import { redactSensitiveValue } from "../utils/secrets.js";
import type { TaskCleanupPlan, TaskCleanupResult, TaskContract, TaskEvidence, TaskToolEvidence } from "./types.js";

export interface TaskManagedProcessController {
  stop(processId: string, reason?: string): Promise<unknown>;
}

/** 执行清理并记录证据；只停任务自己起的受管进程。 */
export async function cleanupTask(
  task: TaskContract,
  toolEvidence: TaskToolEvidence[],
  controller: TaskManagedProcessController | undefined
): Promise<TaskCleanupResult> {
  // 契约是持久数据，清理过程会改状态，所以先拷贝一份再改，不污染传入的契约。
  const cleanup = cloneCleanup(task.cleanup);
  const processIds = [...new Set([...cleanup.processIds, ...startedProcessIds(toolEvidence)])];
  cleanup.processIds = processIds;
  if (cleanup.policy === "not_needed") {
    cleanup.status = "not_needed";
    cleanup.summary = "No task-owned managed-process cleanup is required.";
    cleanup.completedAt = new Date().toISOString();
    return result(cleanup, true, "cleanup:not-needed", cleanup.summary, []);
  }
  if (cleanup.policy === "preserve_task_processes") {
    cleanup.status = "preserved";
    cleanup.summary = processIds.length
      ? `Preserved ${String(processIds.length)} task-owned managed process${processIds.length === 1 ? "" : "es"} for the launch task.`
      : "No task-owned managed processes were started to preserve.";
    cleanup.completedAt = new Date().toISOString();
    return result(cleanup, true, "cleanup:preserved", cleanup.summary, processIds);
  }
  if (!processIds.length) {
    cleanup.status = "not_needed";
    cleanup.summary = "No task-owned managed processes require cleanup.";
    cleanup.completedAt = new Date().toISOString();
    return result(cleanup, true, "cleanup:not-needed", cleanup.summary, []);
  }
  // 有进程要停却拿不到控制器，只能记为失败：不能假装清理干净了。
  if (!controller) {
    cleanup.status = "failed";
    cleanup.summary = "Task-owned managed processes require cleanup, but the managed-process controller is unavailable.";
    cleanup.completedAt = new Date().toISOString();
    return result(cleanup, false, "cleanup:unavailable", cleanup.summary, processIds);
  }

  // 逐个停，单个失败不中断后续：剩下的进程也要尽量停掉，失败信息最后一起汇总。
  const failures: string[] = [];
  const evidence: TaskEvidence[] = [];
  for (const processId of processIds) {
    try {
      const stopped = await controller.stop(processId, "task terminal cleanup");
      evidence.push(cleanupEvidence(`cleanup:${processId}`, true, `Stopped task-owned managed process ${processId}.`, {
        processId,
        result: redactSensitiveValue(stopped)
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${processId}: ${message}`);
      evidence.push(cleanupEvidence(`cleanup:${processId}`, false, `Failed to stop task-owned managed process ${processId}: ${message}`, { processId }));
    }
  }
  cleanup.evidenceIds = evidence.map((item) => item.id);
  cleanup.completedAt = new Date().toISOString();
  if (failures.length) {
    cleanup.status = "failed";
    cleanup.summary = `Managed-process cleanup failed: ${failures.join("; ")}`;
    return { cleanup, evidence, passed: false, summary: cleanup.summary };
  }
  cleanup.status = "completed";
  cleanup.summary = `Stopped ${String(processIds.length)} task-owned managed process${processIds.length === 1 ? "" : "es"}.`;
  return { cleanup, evidence, passed: true, summary: cleanup.summary };
}

function result(
  cleanup: TaskCleanupPlan,
  passed: boolean,
  id: string,
  summary: string,
  processIds: string[]
): TaskCleanupResult {
  const evidence = [cleanupEvidence(id, passed, summary, { policy: cleanup.policy, processIds })];
  cleanup.evidenceIds = evidence.map((item) => item.id);
  return { cleanup, evidence, passed, summary };
}

function cleanupEvidence(
  id: string,
  passed: boolean,
  summary: string,
  details: Record<string, unknown>
): TaskEvidence {
  return {
    id,
    kind: "cleanup",
    parentEvidenceIds: [],
    passed,
    summary,
    observedAt: new Date().toISOString(),
    details
  };
}

function cloneCleanup(cleanup: TaskCleanupPlan): TaskCleanupPlan {
  return {
    ...cleanup,
    processIds: [...cleanup.processIds],
    evidenceIds: [...cleanup.evidenceIds]
  };
}

/** 从工具证据里找出本任务启动过的进程 id（只认 start_process 的返回值）。 */
function startedProcessIds(evidence: TaskToolEvidence[]): string[] {
  return evidence
    .filter((item) => item.tool === "start_process")
    .flatMap((item) => readProcessId(item.result));
}

function readProcessId(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const processId = (value as Record<string, unknown>).processId;
  return typeof processId === "string" && processId ? [processId] : [];
}
