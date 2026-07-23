import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileTaskContract } from "../src/harness/TaskContractCompiler.js";
import { TaskRunStore } from "../src/harness/TaskRunStore.js";

await testInterruptedTaskBecomesContinuable();
await testCompletedTaskPersistsEvidence();
await testTaskSnapshotUsesContractV2Only();

async function testInterruptedTaskBecomesContinuable(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-store-recover-"));
  try {
    const store = await TaskRunStore.open(root);
    await store.create({
      taskRunId: "recoverable-task",
      contract: compileTaskContract({
        objective: "start the project",
        taskType: "launch",
        acceptanceCriteria: [{ id: "manifest", kind: "file_exists", path: "package.json" }],
        verificationMode: "deterministic",
        pendingTodo: ["start services"]
      }),
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
    assert.equal(snapshot.contract.verificationMode, "deterministic");
    assert.deepEqual(snapshot.contract.pendingTodo, ["start services"]);
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
      contract: compileTaskContract({
        objective: "verify project",
        taskType: "conversation",
        acceptanceCriteria: [],
        verificationMode: "model_only"
      }),
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
    assert.equal(snapshot.evidence.some((evidence) => evidence.kind === "agent"), true);
    const verification = snapshot.evidence.find((evidence) => evidence.kind === "verification");
    assert.equal(verification?.parentEvidenceIds.some((id) => id.includes("tool:tool-1")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testTaskSnapshotUsesContractV2Only(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-store-v2-"));
  try {
    const store = await TaskRunStore.open(root);
    await store.create({
      taskRunId: "contract-only",
      contract: compileTaskContract({
        objective: "verify one task source of truth",
        taskType: "conversation",
        acceptanceCriteria: [],
        verificationMode: "model_only",
        pendingTodo: ["respond"]
      }),
      budget: { maxAttempts: 1 }
    });
    const recordPath = path.join(store.directoryPath, "task-run-contract-only.json");
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    assert.equal(record.version, 2);
    assert.equal("objective" in record, false);
    assert.equal("acceptanceCriteria" in record, false);
    assert.equal("verificationMode" in record, false);
    assert.equal("pendingTodo" in record, false);
    assert.equal(typeof record.contract, "object");

    await fs.writeFile(path.join(store.directoryPath, "task-run-v1-record.json"), JSON.stringify({ version: 1 }));
    await assert.rejects(async () => await store.get("v1-record"), /Unsupported task record version/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
