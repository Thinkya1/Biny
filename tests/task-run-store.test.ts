import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRunStore } from "../src/harness/TaskRunStore.js";

await testInterruptedTaskBecomesContinuable();
await testCompletedTaskPersistsEvidence();

async function testInterruptedTaskBecomesContinuable(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-store-recover-"));
  try {
    const store = await TaskRunStore.open(root);
    await store.create({
      taskRunId: "recoverable-task",
      request: {
        objective: "start the project",
        acceptanceCriteria: [{ id: "manifest", kind: "file_exists", path: "package.json" }],
        pendingTodo: ["start services"]
      },
      budget: { maxAttempts: 3, maxRuntimeSteps: 96, maxWallTimeMs: 60_000 }
    });
    await store.markRunning("recoverable-task");
    await store.startAttempt("recoverable-task", { attemptId: "attempt-1", attemptNumber: 1 });

    const reopened = await TaskRunStore.open(root);
    const snapshot = await reopened.get("recoverable-task");
    assert.equal(snapshot.status, "continuable");
    assert.equal(snapshot.recovered, true);
    assert.equal(snapshot.attempts[0]?.status, "incomplete");
    assert.equal(snapshot.attempts[0]?.stopReason, "runtime_restart");
    assert.deepEqual(snapshot.pendingTodo, ["start services"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCompletedTaskPersistsEvidence(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-store-complete-"));
  try {
    const store = await TaskRunStore.open(root);
    await store.create({
      taskRunId: "completed-task",
      sessionId: "session-1",
      rootRunId: "run-1",
      request: { objective: "verify project", acceptanceCriteria: [] },
      budget: { maxAttempts: 2 }
    });
    await store.startAttempt("completed-task", { attemptId: "attempt-1", attemptNumber: 1 });
    await store.completeAttempt("completed-task", "attempt-1", {
      status: "completed",
      output: "done",
      runtimeSteps: 4,
      stopReason: "model_stop",
      finishReason: "stop",
      toolEvidence: [{
        toolCallId: "tool-1",
        tool: "run_command",
        args: { command: "pnpm test" },
        result: { exitCode: 0 },
        observedAt: new Date().toISOString()
      }]
    });
    await store.recordVerification("completed-task", "attempt-1", [{
      criterionId: "tests",
      passed: true,
      summary: "tests passed",
      observedAt: new Date().toISOString()
    }]);
    await store.finish("completed-task", "completed", "All acceptance criteria passed.");

    const reopened = await TaskRunStore.open(root);
    const snapshot = await reopened.get("completed-task");
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.attempts[0]?.toolEvidence[0]?.tool, "run_command");
    assert.equal(snapshot.attempts[0]?.verifierEvidence[0]?.passed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
