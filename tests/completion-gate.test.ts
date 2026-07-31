import assert from "node:assert/strict";
import {
  CompletionGate,
  RunFactsCollector,
  type BlockedState,
  type CompletionBudgetSnapshot,
  type CompletionGateVerifier,
  type CompletionVerification,
  type RunFacts,
  type StructuredVerificationCheck,
  type VerificationFact
} from "../src/agent/completionGate.js";
import type { TodoItem } from "../src/session/todoStore.js";

async function testPlainCompletion(): Promise<void> {
  const gate = createGate();
  assert.deepEqual(await gate.decide(createFacts(), createBudget()), { kind: "complete" });
}

async function testTodoCompletionConstraint(): Promise<void> {
  for (const status of ["pending", "in_progress"] as const) {
    const todos: TodoItem[] = [{ content: `${status} work`, status }];
    const gate = createGate({ todos });
    const decision = await gate.decide(createFacts(), createBudget());
    assert.equal(decision.kind, "continue");
    if (decision.kind !== "continue") throw new Error("unfinished Todo did not continue");
    assert.equal(decision.feedback.role, "system", "completion feedback must be an internal system message");
    assert.match(String(decision.feedback.content), /Continue the same user task/);
    assert.doesNotMatch(String(decision.feedback.content), /role.*user/i);
  }

  const completed = createGate({
    todos: [{ content: "finished work", status: "completed" }]
  });
  assert.deepEqual(await completed.decide(createFacts(), createBudget()), { kind: "complete" });
}

async function testPendingApproval(): Promise<void> {
  const decision = await createGate().decide(
    createFacts({ pendingApprovals: 1 }),
    createBudget()
  );
  assert.deepEqual(decision, {
    kind: "blocked",
    reason: "waiting_for_approval",
    summary: "A tool approval is still pending.",
    requiredAction: "Approve or reject the pending tool request."
  });
}

async function testCancellation(): Promise<void> {
  assert.deepEqual(
    await createGate().decide(createFacts({ userCancelled: true }), createBudget()),
    { kind: "cancelled" }
  );

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await createGate().decide(createFacts(), createBudget(), controller.signal),
    { kind: "cancelled" }
  );
}

async function testHardLimit(): Promise<void> {
  const decision = await createGate().decide(
    createFacts(),
    createBudget({ steps: 12, hardStepLimit: 12 })
  );
  assert.equal(decision.kind, "incomplete");
  if (decision.kind !== "incomplete") throw new Error("hard limit did not stop as incomplete");
  assert.equal(decision.reason, "hard_step_limit");
  assert.equal(decision.resumable, true);
}

async function testVerificationFailureThenPass(): Promise<void> {
  const checks: StructuredVerificationCheck[] = [{
    id: "typecheck",
    kind: "command",
    description: "Typecheck the project",
    command: "pnpm typecheck"
  }];
  const failed: VerificationFact = {
    passed: false,
    summary: "typecheck failed",
    evidence: [{ id: "typecheck", passed: false, summary: "exit code 2" }]
  };
  const passed: VerificationFact = {
    passed: true,
    summary: "typecheck passed",
    evidence: [{ id: "typecheck", passed: true, summary: "exit code 0" }]
  };
  const verifier = new ScriptedVerifier([failed, passed], true);
  const recorded: VerificationFact[] = [];
  const gate = createGate({ checks, verifier, onVerification: (result) => recorded.push(result) });

  const first = await gate.decide(createFacts({ changedFiles: ["src/a.ts"] }), createBudget());
  assert.equal(first.kind, "continue");
  const second = await gate.decide(createFacts({ changedFiles: ["src/a.ts"] }), createBudget());
  assert.deepEqual(second, { kind: "complete" });
  assert.equal(verifier.verifyCalls, 2, "a failed check must rerun after the same-loop repair continuation");
  assert.deepEqual(recorded, [failed, passed]);
}

async function testNoProgressLimit(): Promise<void> {
  const gate = createGate({
    todos: [{ content: "still pending", status: "pending" }]
  });
  const budget = createBudget({
    maxCompletionContinuations: 10,
    maxRepeatedActions: 2
  });
  assert.equal((await gate.decide(createFacts(), budget)).kind, "continue");
  assert.equal((await gate.decide(createFacts(), budget)).kind, "continue");
  const stopped = await gate.decide(createFacts(), budget);
  assert.equal(stopped.kind, "incomplete");
  if (stopped.kind !== "incomplete") throw new Error("stagnant continuation did not stop");
  assert.equal(stopped.reason, "no_progress_after_continuation");
  assert.equal(stopped.resumable, true);
}

async function testContinuationLimit(): Promise<void> {
  const gate = createGate({
    todos: [{ content: "bounded continuation", status: "pending" }]
  });
  const budget = createBudget({
    maxCompletionContinuations: 2,
    maxRepeatedActions: 10
  });
  assert.equal((await gate.decide(createFacts({ actualToolCallCount: 0 }), budget)).kind, "continue");
  assert.equal((await gate.decide(createFacts({ actualToolCallCount: 1 }), budget)).kind, "continue");
  const stopped = await gate.decide(createFacts({ actualToolCallCount: 2 }), budget);
  assert.equal(stopped.kind, "incomplete");
  if (stopped.kind !== "incomplete") throw new Error("continuation count did not stop");
  assert.equal(stopped.reason, "completion_continuation_limit");
}

async function testToolAndRepeatedActionLimits(): Promise<void> {
  const tools = new RunFactsCollector();
  tools.observeActualToolCalls([
    { toolCallId: "1", toolName: "read_file", input: { path: "a.ts" } },
    { toolCallId: "2", toolName: "read_file", input: { path: "b.ts" } },
    { toolCallId: "3", toolName: "read_file", input: { path: "c.ts" } }
  ]);
  const toolLimit = await createGate().decide(
    tools.snapshot(false),
    createBudget({ maxToolCalls: 3, maxRepeatedActions: 10 })
  );
  assert.equal(toolLimit.kind, "incomplete");
  if (toolLimit.kind !== "incomplete") throw new Error("tool limit did not stop");
  assert.equal(toolLimit.reason, "tool_call_limit");

  const repeated = new RunFactsCollector();
  repeated.observeActualToolCalls([
    { toolCallId: "1", toolName: "read_file", input: { path: "same.ts" } },
    { toolCallId: "2", toolName: "read_file", input: { path: "same.ts" } }
  ]);
  const repeatedLimit = await createGate().decide(
    repeated.snapshot(false),
    createBudget({ maxToolCalls: 10, maxRepeatedActions: 2 })
  );
  assert.equal(repeatedLimit.kind, "incomplete");
  if (repeatedLimit.kind !== "incomplete") throw new Error("repeated action limit did not stop");
  assert.equal(repeatedLimit.reason, "repeated_action_limit");
}

async function testStructuredBlockedState(): Promise<void> {
  const gate = createGate({
    blocked: {
      reason: "missing_user_input",
      summary: "The deployment target is ambiguous.",
      requiredAction: "Choose staging or production.",
      affectedTodoIds: ["deploy"]
    }
  });
  assert.deepEqual(await gate.decide(createFacts(), createBudget()), {
    kind: "blocked",
    reason: "missing_user_input",
    summary: "The deployment target is ambiguous.",
    requiredAction: "Choose staging or production.",
    affectedTodoIds: ["deploy"]
  });
}

function testVerificationFactsDoNotManufactureProgress(): void {
  const collector = new RunFactsCollector();
  const result: VerificationFact = {
    passed: false,
    summary: "same failure",
    evidence: [{ id: "test", passed: false, summary: "exit code 1" }]
  };
  collector.recordVerification(result);
  collector.recordVerification(result);
  assert.equal(collector.snapshot(false).verificationResults.length, 1);
}

function testWorkspaceMutationFactSurvivesPersistence(): void {
  const collector = new RunFactsCollector();
  assert.equal(collector.snapshot(false).workspaceMutationObserved, false);
  collector.markWorkspaceMutationObserved();
  const persisted = collector.snapshot(false);
  assert.equal(persisted.workspaceMutationObserved, true);
  assert.equal(new RunFactsCollector(persisted).snapshot(false).workspaceMutationObserved, true);
}

function testUnrelatedSuccessDoesNotResolveEarlierToolFailure(): void {
  const collector = new RunFactsCollector();
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "failed",
    tool: "run_command",
    args: { command: "false" }
  });
  collector.observeToolEvent({
    type: "tool.failed",
    toolCallId: "failed",
    tool: "run_command",
    error: "exit code 1",
    result: { status: "failed", exitCode: 1 }
  });
  assert.equal(collector.snapshot(false).failedToolCalls.length, 1);

  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "unrelated",
    tool: "read_file",
    args: { path: "README.md" }
  });
  collector.observeToolEvent({
    type: "tool.completed",
    toolCallId: "unrelated",
    tool: "read_file",
    result: { path: "README.md", content: "ok" }
  });
  assert.equal(collector.snapshot(false).failedToolCalls.length, 1);
}

function testMatchingActionSuccessResolvesEarlierToolFailure(): void {
  const collector = new RunFactsCollector();
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "failed",
    tool: "run_command",
    args: { command: "pnpm test" }
  });
  collector.observeToolEvent({
    type: "tool.failed",
    toolCallId: "failed",
    tool: "run_command",
    error: "exit code 1",
    result: { status: "failed", exitCode: 1 }
  });
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "retry",
    tool: "run_command",
    args: { command: "pnpm test" }
  });
  collector.observeToolEvent({
    type: "tool.completed",
    toolCallId: "retry",
    tool: "run_command",
    result: { status: "completed", exitCode: 0 }
  });
  assert.equal(collector.snapshot(false).failedToolCalls.length, 0);
}

function testValidationFailureRequiresSuccessfulSameTool(): void {
  const collector = new RunFactsCollector();
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "invalid",
    tool: "write_file",
    args: { path: 123, content: "bad" }
  });
  collector.observeToolEvent({
    type: "tool.failed",
    toolCallId: "invalid",
    tool: "write_file",
    error: "Invalid tool arguments for write_file.",
    result: { error: "Invalid tool arguments for write_file.", validation: true }
  });
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "unrelated",
    tool: "read_file",
    args: { path: "README.md" }
  });
  collector.observeToolEvent({
    type: "tool.completed",
    toolCallId: "unrelated",
    tool: "read_file",
    result: { path: "README.md", content: "ok" }
  });
  assert.equal(
    collector.snapshot(false).failedToolCalls.length,
    1,
    "an unrelated valid tool cannot resolve a schema failure"
  );

  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "corrected",
    tool: "write_file",
    args: { path: "src/a.ts", content: "valid" }
  });
  collector.observeToolEvent({
    type: "tool.completed",
    toolCallId: "corrected",
    tool: "write_file",
    result: { path: "src/a.ts" }
  });
  assert.equal(
    collector.snapshot(false).failedToolCalls.length,
    0,
    "a valid call to the same tool resolves its earlier schema failure"
  );
}

async function testPermissionFailureSurvivesUnrelatedSuccess(): Promise<void> {
  const collector = new RunFactsCollector();
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "denied",
    tool: "write_file",
    args: { path: "src/a.ts", content: "new content" }
  });
  collector.observeToolEvent({
    type: "tool.failed",
    toolCallId: "denied",
    tool: "write_file",
    error: "Denied by user.",
    result: { status: "denied", approved: false }
  });
  collector.observeToolEvent({
    type: "tool.started",
    toolCallId: "read",
    tool: "read_file",
    args: { path: "README.md" }
  });
  collector.observeToolEvent({
    type: "tool.completed",
    toolCallId: "read",
    tool: "read_file",
    result: { path: "README.md", content: "ok" }
  });

  const decision = await createGate().decide(collector.snapshot(false), createBudget());
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") throw new Error("permission failure was not retained");
  assert.equal(decision.reason, "permission_denied");
}

interface GateFixture {
  todos?: TodoItem[];
  checks?: StructuredVerificationCheck[];
  blocked?: BlockedState;
  verifier?: CompletionGateVerifier;
  onVerification?: (result: VerificationFact) => void;
}

function createGate(fixture: GateFixture = {}): CompletionGate {
  return new CompletionGate({
    verifier: fixture.verifier ?? new ScriptedVerifier([], false),
    listTodos: () => fixture.todos?.map((todo) => ({ ...todo })) ?? [],
    listRequestedChecks: () => fixture.checks?.map((check) => ({ ...check })) ?? [],
    blockedState: () => fixture.blocked,
    onVerification: fixture.onVerification
  });
}

class ScriptedVerifier implements CompletionGateVerifier {
  verifyCalls = 0;

  constructor(
    private readonly results: readonly VerificationFact[],
    private readonly required: boolean
  ) {}

  async derive(
    _facts: RunFacts,
    requestedChecks: readonly StructuredVerificationCheck[]
  ): Promise<CompletionVerification> {
    return { required: this.required, checks: requestedChecks.map((check) => ({ ...check })) };
  }

  async verify(): Promise<VerificationFact> {
    const result = this.results[this.verifyCalls];
    this.verifyCalls += 1;
    if (!result) throw new Error("Unexpected verifier invocation.");
    return {
      ...result,
      evidence: result.evidence.map((evidence) => ({ ...evidence }))
    };
  }
}

function createFacts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    actualToolCallCount: 0,
    workspaceMutationObserved: false,
    changedFiles: [],
    executedCommands: [],
    failedToolCalls: [],
    pendingApprovals: 0,
    activeToolCalls: 0,
    activeProcesses: [],
    startedProcessIds: [],
    verificationResults: [],
    userCancelled: false,
    maxRepeatedActionCount: 0,
    ...overrides
  };
}

function createBudget(overrides: Partial<CompletionBudgetSnapshot> = {}): CompletionBudgetSnapshot {
  return {
    steps: 0,
    softStepLimit: 4,
    hardStepLimit: 12,
    maxToolCalls: 20,
    maxCompletionContinuations: 3,
    maxRepeatedActions: 3,
    ...overrides
  };
}

await testPlainCompletion();
await testTodoCompletionConstraint();
await testPendingApproval();
await testCancellation();
await testHardLimit();
await testVerificationFailureThenPass();
await testNoProgressLimit();
await testContinuationLimit();
await testToolAndRepeatedActionLimits();
await testStructuredBlockedState();
testVerificationFactsDoNotManufactureProgress();
testWorkspaceMutationFactSurvivesPersistence();
testUnrelatedSuccessDoesNotResolveEarlierToolFailure();
testMatchingActionSuccessResolvesEarlierToolFailure();
testValidationFailureRequiresSuccessfulSameTool();
await testPermissionFailureSurvivesUnrelatedSuccess();

console.log("completion gate tests passed");
