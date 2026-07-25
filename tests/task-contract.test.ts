import assert from "node:assert/strict";
import { cleanupTask } from "../src/harness/TaskCleanup.js";
import { compileTaskContract } from "../src/harness/TaskContractCompiler.js";
import { judgeTaskTerminal } from "../src/harness/TaskDecisionEngine.js";
import { advanceTaskPlan } from "../src/harness/TaskPlanner.js";

await testCodeContractRequiresImplementationAndCleanup();
await testCommandEvidenceCanAdvanceImplementationPlan();
await testCleanupStopsOnlyTaskOwnedProcesses();

async function testCodeContractRequiresImplementationAndCleanup(): Promise<void> {
  const contract = compileTaskContract({
    objective: "fix the parser",
    taskType: "code_change",
    acceptanceCriteria: [{ id: "typecheck", kind: "command_succeeded", command: "node -e \"process.exit(0)\"" }],
    verificationMode: "deterministic",
    artifacts: ["package.json"]
  });
  const verifiedPlan = advanceTaskPlan(contract.plan, {
    taskType: contract.taskType,
    attemptId: "attempt-1",
    verificationPassed: true,
    cleanup: { ...contract.cleanup, status: "completed", evidenceIds: ["cleanup:done"] }
  });
  const decision = judgeTaskTerminal(contract, { passed: true, summary: "verified" }, verifiedPlan, {
    ...contract.cleanup,
    status: "completed",
    evidenceIds: ["cleanup:done"]
  });
  assert.equal(decision.passed, false);
  assert.match(decision.summary, /Implement the requested workspace changes/u);
}

async function testCleanupStopsOnlyTaskOwnedProcesses(): Promise<void> {
  const contract = compileTaskContract({
    objective: "fix a service test",
    taskType: "code_change",
    acceptanceCriteria: [],
    verificationMode: "deterministic"
  });
  const stopped: string[] = [];
  const result = await cleanupTask(contract, [{
    toolCallId: "start-1",
    tool: "start_process",
    result: { processId: "process-1" },
    observedAt: new Date().toISOString()
  }], {
    stop: async (processId) => {
      stopped.push(processId);
      return { processId, state: "stopped" };
    }
  });
  assert.equal(result.passed, true, result.summary);
  assert.deepEqual(stopped, ["process-1"]);
  assert.equal(result.cleanup.status, "completed");
  assert.equal(result.evidence[0]?.kind, "cleanup");
}

async function testCommandEvidenceCanAdvanceImplementationPlan(): Promise<void> {
  const contract = compileTaskContract({
    objective: "deduplicate the input file",
    taskType: "code_change",
    acceptanceCriteria: [{ id: "changed", kind: "workspace_changed", baselineDigest: "before" }],
    verificationMode: "deterministic"
  });
  const plan = advanceTaskPlan(contract.plan, {
    taskType: contract.taskType,
    attemptId: "attempt-1",
    toolEvidence: [{
      toolCallId: "command-1",
      tool: "run_command",
      args: { command: "awk '!seen[$0]++' input.txt > output.txt" },
      result: { status: "completed", exitCode: 0 },
      observedAt: new Date().toISOString()
    }]
  });
  assert.equal(plan.find((item) => item.id === "implement")?.status, "completed");
}
