import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcceptanceVerifier } from "../src/harness/AcceptanceVerifier.js";
import { compileTaskContract } from "../src/harness/TaskContractCompiler.js";
import type { AcceptanceCriterion, AgentAttemptExecution, TaskContract, TaskVerificationMode } from "../src/harness/types.js";
import { workspaceStateDigest } from "../src/harness/WorkspaceState.js";

await testRequiresTerminalModelStop();
await testDeterministicTaskCannotPassWithoutCriteria();
await testWorkspaceChangeUsesTaskBaseline();
await testLaunchProcessRequiresHttpReadiness();
await testVerifierSelectsReadyManagedProcess();
await testVerifierExecutesCommandsIndependently();

async function testRequiresTerminalModelStop(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-outcome-"));
  try {
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verify(contract("continue", []), attempt({
      outcomeStatus: "incomplete",
      stopReason: "step_limit"
    }));
    assert.equal(result.passed, false);
    assert.match(result.summary, /step_limit/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifierSelectsReadyManagedProcess(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-ready-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      managedProcesses: {
        listProcesses: () => [
          { processId: "failed-first", state: "running", cwd: root, readiness: { type: "log", passed: false } },
          { processId: "ready-second", state: "running", cwd: root, readiness: { type: "log", passed: true } }
        ]
      }
    });
    const result = await verifier.verify(contract("keep the service running", [{ id: "service", kind: "managed_process", cwd: "." }]), attempt({}));
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence[0]?.details?.processId, "ready-second");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLaunchProcessRequiresHttpReadiness(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-http-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      managedProcesses: {
        listProcesses: () => [{
          processId: "process-log-only",
          state: "running",
          readiness: { type: "log", passed: true }
        }]
      }
    });
    const result = await verifier.verify(contract("start the project", [{
        id: "service",
        kind: "managed_process",
        processId: "process-log-only",
        requireHttpReadiness: true
      }]), attempt({}));
    assert.equal(result.passed, false);
    assert.match(result.summary, /required HTTP readiness/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testDeterministicTaskCannotPassWithoutCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-empty-deterministic-"));
  try {
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verify(contract("implement a code change", [], "deterministic"), attempt({}));
    assert.equal(result.passed, false);
    assert.match(result.summary, /no executable acceptance criteria/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testWorkspaceChangeUsesTaskBaseline(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-workspace-state-"));
  try {
    await fs.writeFile(path.join(root, "source.txt"), "before\n");
    const baselineDigest = await workspaceStateDigest(root);
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const unchanged = await verifier.verify(contract("change source", [{ id: "workspace", kind: "workspace_changed", baselineDigest }]), attempt({}));
    assert.equal(unchanged.passed, false);

    await fs.writeFile(path.join(root, "source.txt"), "after\n");
    const changed = await verifier.verify(contract("change source", [{ id: "workspace", kind: "workspace_changed", baselineDigest }]), attempt({}));
    assert.equal(changed.passed, true, changed.summary);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifierExecutesCommandsIndependently(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-evidence-"));
  const originalFetch = globalThis.fetch;
  try {
    await fs.writeFile(path.join(root, "package.json"), "{}\n");
    const url = "http://127.0.0.1:43210/ready";
    globalThis.fetch = (async (input): Promise<Response> => {
      assert.equal(String(input), url);
      return new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const task = contract("start and verify", [
        { id: "manifest", kind: "file_exists", path: "package.json" },
        { id: "build", kind: "command_succeeded", command: "node -e \"process.exit(0)\"" },
        { id: "http", kind: "http", url },
        { id: "process", kind: "managed_process", processId: "process-1", requireHttpReadiness: true }
      ]);
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      managedProcesses: {
        listProcesses: () => [{ processId: "process-1", state: "running", url, readiness: { type: "http", passed: true } }]
      }
    });
    const result = await verifier.verify(task, attempt({
      toolEvidence: [{
        toolCallId: "tool-1",
        tool: "run_command",
        args: { command: "node -e \"process.exit(0)\"" },
        result: { exitCode: 17, status: "failed" },
        observedAt: new Date().toISOString()
      }]
    }));
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence.length, 4);
    assert.equal(result.evidence.find((evidence) => evidence.criterionId === "build")?.details?.execution, "independent_verifier");

    const independentFailure = await verifier.verify(contract("verify the failing command", [{ id: "build", kind: "command_succeeded", command: "node -e \"process.exit(5)\"" }]), attempt({
      toolEvidence: [{
        toolCallId: "tool-2",
        tool: "run_command",
        args: { command: "node -e \"process.exit(5)\"" },
        result: { exitCode: 0, status: "completed" },
        observedAt: new Date().toISOString()
      }]
    }));
    assert.equal(independentFailure.passed, false);
    assert.match(independentFailure.summary, /independent verifier run/u);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function attempt(overrides: Partial<AgentAttemptExecution>): AgentAttemptExecution {
  return {
    output: "done",
    runtimeSteps: 1,
    outcomeStatus: "completed",
    stopReason: "model_stop",
    finishReason: "stop",
    attemptToolEvidence: [],
    toolEvidence: [],
    ...overrides
  };
}

function contract(
  objective: string,
  acceptanceCriteria: AcceptanceCriterion[],
  verificationMode: TaskVerificationMode = "model_only"
): TaskContract {
  return compileTaskContract({
    objective,
    taskType: "conversation",
    acceptanceCriteria,
    verificationMode
  });
}
