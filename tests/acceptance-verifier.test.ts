import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcceptanceVerifier } from "../src/harness/AcceptanceVerifier.js";
import type { AgentAttemptExecution, TaskRequest } from "../src/harness/types.js";

await testRequiresTerminalModelStop();
await testLaunchProcessRequiresHttpReadiness();
await testVerifierSelectsReadyManagedProcess();
await testVerifiesFreshAndRecordedEvidence();

async function testRequiresTerminalModelStop(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-outcome-"));
  try {
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verify({ objective: "continue", acceptanceCriteria: [] }, attempt({
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
    const result = await verifier.verify({
      objective: "keep the service running",
      acceptanceCriteria: [{ id: "service", kind: "managed_process", cwd: "." }]
    }, attempt({}));
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
    const result = await verifier.verify({
      objective: "start the project",
      acceptanceCriteria: [{
        id: "service",
        kind: "managed_process",
        processId: "process-log-only",
        requireHttpReadiness: true
      }]
    }, attempt({}));
    assert.equal(result.passed, false);
    assert.match(result.summary, /required HTTP readiness/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifiesFreshAndRecordedEvidence(): Promise<void> {
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
    const task: TaskRequest = {
      objective: "start and verify",
      acceptanceCriteria: [
        { id: "manifest", kind: "file_exists", path: "package.json" },
        { id: "build", kind: "command_succeeded", commandPattern: "(?:^|\\s)build(?:$|\\s)" },
        { id: "http", kind: "http", url },
        { id: "process", kind: "managed_process", processId: "process-1", requireHttpReadiness: true }
      ]
    };
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
        args: { command: "npm run build" },
        result: { exitCode: 0, status: "completed" },
        observedAt: new Date().toISOString()
      }]
    }));
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence.length, 4);
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
