import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveAgentVerificationPlan,
  verifyAgentRun
} from "../src/agent/verification.js";
import {
  createControlledAcceptanceCommandExecutor,
  type AcceptanceCommandAuditEvent,
  type AcceptanceCommandExecutor
} from "../src/harness/AcceptanceCommandExecutor.js";
import { AcceptanceVerifier } from "../src/harness/AcceptanceVerifier.js";
import { compileTaskContract } from "../src/harness/TaskContractCompiler.js";
import type { AcceptanceCriterion, AgentAttemptExecution, TaskContract, TaskVerificationMode } from "../src/harness/types.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import {
  captureWorkspaceState,
  diffWorkspaceStates,
  workspaceStateDigest
} from "../src/harness/WorkspaceState.js";

await testRequiresTerminalModelStop();
await testCriteriaVerificationDoesNotRequireAgentCompletion();
await testCriteriaVerificationSupportsCancellation();
await testDeterministicTaskCannotPassWithoutCriteria();
await testWorkspaceChangeUsesTaskBaseline();
await testWorkspaceSnapshotReportsChangedFiles();
await testVerificationPlanUsesFactsInsteadOfInputKeywords();
await testAgentRunVerificationExecutesStructuredChecksAndProcesses();
await testLaunchProcessRequiresHttpReadiness();
await testVerifierSelectsReadyManagedProcess();
await testVerifierExecutesCommandsIndependently();
await testCommandCriterionRequiresControlledExecutor();
await testAutoDiscoveredCheckCannotBypassDefaultAsk();
await testControlledExecutorUsesApprovalSandboxAndAudit();

async function testRequiresTerminalModelStop(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-outcome-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root)
    });
    const result = await verifier.verify(contract("continue", []), attempt({
      outcomeStatus: "incomplete",
      stopReason: "step_limit"
    }));
    assert.equal(result.passed, false);
    assert.match(result.summary, /step_limit/u);
    const completed = await verifier.verify(contract("done", []), attempt({
      stopReason: "completion_gate"
    }));
    assert.equal(completed.passed, true, completed.summary);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCriteriaVerificationDoesNotRequireAgentCompletion(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-criteria-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root)
    });
    const result = await verifier.verifyCriteria([{
      id: "independent-command",
      kind: "command_succeeded",
      command: "node -e \"process.exit(0)\""
    }], { requireCriteria: true });
    assert.equal(result.passed, true, result.summary);
    assert.equal(result.evidence[0]?.details?.execution, "independent_verifier");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCriteriaVerificationSupportsCancellation(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-cancel-"));
  try {
    const controller = new AbortController();
    controller.abort(new Error("verification cancelled"));
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    await assert.rejects(verifier.verifyCriteria([{
      id: "must-not-run",
      kind: "command_succeeded",
      command: "node -e \"setTimeout(() => process.exit(0), 10000)\""
    }], { signal: controller.signal }), /verification cancelled/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerifierSelectsReadyManagedProcess(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-ready-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
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

async function testWorkspaceSnapshotReportsChangedFiles(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-workspace-diff-"));
  try {
    await fs.writeFile(path.join(root, "modified.ts"), "before\n");
    await fs.writeFile(path.join(root, "deleted.ts"), "delete me\n");
    const before = await captureWorkspaceState(root);
    await fs.writeFile(path.join(root, "modified.ts"), "after\n");
    await fs.rm(path.join(root, "deleted.ts"));
    await fs.writeFile(path.join(root, "added.ts"), "added\n");
    const after = await captureWorkspaceState(root);
    const diff = diffWorkspaceStates(before, after);
    assert.deepEqual(diff.addedFiles, ["added.ts"]);
    assert.deepEqual(diff.modifiedFiles, ["modified.ts"]);
    assert.deepEqual(diff.deletedFiles, ["deleted.ts"]);
    assert.deepEqual(diff.changedFiles, ["added.ts", "deleted.ts", "modified.ts"]);
    assert.notEqual(diff.beforeDigest, diff.afterDigest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testVerificationPlanUsesFactsInsteadOfInputKeywords(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verification-plan-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "node build.js",
        test: "node test.js",
        typecheck: "tsc --noEmit",
        lint: "eslint ."
      }
    }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.mkdir(path.join(root, "backend"));
    await fs.writeFile(path.join(root, "backend", "pom.xml"), "<project/>\n");
    await fs.writeFile(path.join(root, "backend", "mvnw"), "#!/bin/sh\n");

    const plan = await deriveAgentVerificationPlan(root, {
      changedFiles: ["src/feature.ts"],
      checks: [{
        id: "explicit-check",
        command: "node explicit-check.js",
        cwd: "."
      }],
      startedProcesses: [{
        processId: "process-123",
        cwd: ".",
        readinessType: "http",
        url: "http://127.0.0.1:32123/health"
      }]
    });
    const commands = plan.criteria.flatMap((criterion) =>
      criterion.kind === "command_succeeded" ? [criterion.command] : []
    );
    assert.equal(plan.required, true);
    assert.equal(commands.includes("node explicit-check.js"), true);
    assert.equal(commands.includes("pnpm run build"), true);
    assert.equal(commands.includes("pnpm run test"), true);
    assert.equal(commands.includes("pnpm run typecheck"), true);
    assert.equal(commands.includes("pnpm run lint"), true);
    assert.equal(commands.includes("./mvnw test"), true);
    assert.equal(plan.criteria.some((criterion) =>
      criterion.kind === "managed_process"
      && criterion.processId === "process-123"
      && criterion.requireHttpReadiness === true
    ), true);

    const noFacts = await deriveAgentVerificationPlan(root, {
      changedFiles: [],
      checks: [],
      startedProcesses: []
    });
    assert.equal(noFacts.required, false);
    assert.deepEqual(noFacts.criteria, []);

    const explicitlyRequired = await verifyAgentRun({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      facts: {
        changedFiles: [],
        userRequestedVerification: true,
        checks: [],
        startedProcesses: []
      }
    });
    assert.equal(explicitlyRequired.plan.required, true);
    assert.equal(explicitlyRequired.plan.reasons.includes("user_requested_verification"), true);
    assert.equal(explicitlyRequired.verification?.passed, false);
    assert.match(explicitlyRequired.verification?.summary ?? "", /no executable acceptance criteria/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAgentRunVerificationExecutesStructuredChecksAndProcesses(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-agent-verification-"));
  try {
    const processId = "process-verified";
    const result = await verifyAgentRun({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
      facts: {
        changedFiles: [],
        checks: [{
          id: "structured-command",
          command: "node -e \"process.exit(0)\""
        }],
        startedProcesses: [{ processId, readinessType: "log" }]
      },
      managedProcesses: {
        listProcesses: () => [{
          processId,
          state: "running",
          readiness: { type: "log", passed: true }
        }]
      }
    });
    assert.equal(result.plan.required, true);
    assert.equal(result.verification?.passed, true, result.verification?.summary);
    assert.equal(result.verification?.evidence.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testLaunchProcessRequiresHttpReadiness(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-http-process-"));
  try {
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: trustedCommandExecutor(root),
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

async function testCommandCriterionRequiresControlledExecutor(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-controlled-required-"));
  try {
    const marker = path.join(root, "must-not-exist.txt");
    const verifier = new AcceptanceVerifier({ workspaceRoot: root });
    const result = await verifier.verifyCriteria([{
      id: "unsafe-without-executor",
      kind: "command_succeeded",
      command: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe")`)}`
    }], { requireCriteria: true });

    assert.equal(result.passed, false);
    assert.match(result.summary, /controlled command executor is required/u);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAutoDiscoveredCheckCannotBypassDefaultAsk(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-auto-approval-"));
  try {
    const marker = path.join(root, "auto-check-ran.txt");
    const audit: AcceptanceCommandAuditEvent[] = [];
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)}`
      }
    }));
    const result = await verifyAgentRun({
      workspaceRoot: root,
      facts: {
        changedFiles: ["src/changed.ts"],
        checks: [],
        startedProcesses: []
      },
      commandExecutor: createControlledAcceptanceCommandExecutor({
        workspaceRoot: root,
        sandbox: { mode: "off", allowNetwork: true },
        permissionManager: new PermissionManager({
          mode: "ask",
          allowTools: [],
          denyPaths: []
        }),
        sessionId: "verification-test",
        onAuditEvent: (event) => {
          audit.push(event);
        }
      })
    });

    assert.equal(result.plan.required, true);
    assert.equal(result.verification?.passed, false);
    assert.match(result.verification?.summary ?? "", /requires explicit approval/u);
    assert.equal(
      audit.find((event) => event.type === "command.failed")?.failureKind,
      "permission_required"
    );
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testControlledExecutorUsesApprovalSandboxAndAudit(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-verifier-controlled-executor-"));
  try {
    const prompts: string[] = [];
    const audit: AcceptanceCommandAuditEvent[] = [];
    const verifier = new AcceptanceVerifier({
      workspaceRoot: root,
      commandExecutor: createControlledAcceptanceCommandExecutor({
        workspaceRoot: root,
        sandbox: { mode: "workspace-write", allowNetwork: false },
        permissionManager: new PermissionManager({
          mode: "ask",
          allowTools: [],
          denyPaths: []
        }),
        sessionId: "verification-test",
        confirmPermission: async (request) => {
          prompts.push(request.command ?? "");
          return {
            approved: true,
            scope: "once",
            confirmation: "yes"
          };
        },
        onAuditEvent: (event) => {
          audit.push(event);
        }
      })
    });
    const result = await verifier.verifyCriteria([{
      id: "approved-check",
      kind: "command_succeeded",
      command: "node -e \"process.exit(0)\""
    }], { requireCriteria: true });

    assert.equal(result.passed, true, result.summary);
    assert.deepEqual(prompts, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(audit.map((event) => event.type), [
      "command.started",
      "command.completed"
    ]);
    assert.notEqual(result.evidence[0]?.details?.sandbox, "off");
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
      commandExecutor: trustedCommandExecutor(root),
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

function trustedCommandExecutor(workspaceRoot: string): AcceptanceCommandExecutor {
  return createControlledAcceptanceCommandExecutor({
    workspaceRoot,
    sandbox: { mode: "off", allowNetwork: true },
    permissionManager: new PermissionManager({
      mode: "full-access",
      allowTools: [],
      denyPaths: []
    }),
    sessionId: "acceptance-verifier-test"
  });
}
