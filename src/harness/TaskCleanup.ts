import { redactSensitiveValue } from "../utils/secrets.js";
import type { TaskCleanupPlan, TaskCleanupResult, TaskContract, TaskEvidence, TaskToolEvidence } from "./types.js";

export interface TaskManagedProcessController {
  stop(processId: string, reason?: string): Promise<unknown>;
}

/** Performs only task-owned managed-process cleanup and records its evidence. */
export async function cleanupTask(
  task: TaskContract,
  toolEvidence: TaskToolEvidence[],
  controller: TaskManagedProcessController | undefined
): Promise<TaskCleanupResult> {
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
  if (!controller) {
    cleanup.status = "failed";
    cleanup.summary = "Task-owned managed processes require cleanup, but the managed-process controller is unavailable.";
    cleanup.completedAt = new Date().toISOString();
    return result(cleanup, false, "cleanup:unavailable", cleanup.summary, processIds);
  }

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
