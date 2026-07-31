import assert from "node:assert/strict";
import { CompletionStateStore } from "../src/agent/completionState.js";
import { createCompletionStateTools } from "../src/tools/completion.js";
import type { RunnableToolExecution, Tool, ToolExecution } from "../src/tools/types.js";

await testStoreCopiesAndReset();
await testStructuredTools();

console.log("completion state tests passed");

async function testStoreCopiesAndReset(): Promise<void> {
  const store = new CompletionStateStore();
  const affectedTodoIds = ["todo-1"];
  const reported = store.reportBlocked({
    reason: "missing_dependency",
    summary: "The compiler is missing.",
    requiredAction: "Install the compiler.",
    affectedTodoIds
  });
  affectedTodoIds.push("mutated-outside");
  reported.affectedTodoIds?.push("mutated-return");
  assert.deepEqual(store.getBlocked()?.affectedTodoIds, ["todo-1"]);

  const checks = [{
    id: "test",
    kind: "command" as const,
    description: "Run tests",
    command: "pnpm test"
  }];
  const returned = store.replaceChecks(checks);
  returned[0]!.command = "changed";
  assert.equal(store.listChecks()[0]?.command, "pnpm test");

  store.clearBlocked();
  assert.equal(store.getBlocked(), undefined);
  assert.equal(store.listChecks()[0]?.command, "pnpm test");

  store.reset();
  assert.equal(store.getBlocked(), undefined);
  assert.deepEqual(store.listChecks(), []);
}

async function testStructuredTools(): Promise<void> {
  const store = new CompletionStateStore();
  const tools = createCompletionStateTools(store);
  const blockedTool = findTool(tools, "report_blocked");
  const verificationTool = findTool(tools, "request_verification");

  assert.throws(() => blockedTool.schema.parse({
    reason: "not_a_reason",
    summary: "invalid"
  }));
  const blockedArgs = blockedTool.schema.parse({
    reason: "environment_unavailable",
    summary: "The simulator is offline.",
    requiredAction: "Start the simulator.",
    affectedTodoIds: ["integration"]
  });
  const blockedExecution = runnable(await blockedTool.resolveExecution(blockedArgs));
  assert.deepEqual(blockedExecution.accesses, []);
  assert.deepEqual(
    await blockedExecution.execute({ toolCallId: "blocked-1" }),
    {
      reason: "environment_unavailable",
      summary: "The simulator is offline.",
      requiredAction: "Start the simulator.",
      affectedTodoIds: ["integration"]
    }
  );
  assert.equal(store.getBlocked()?.reason, "environment_unavailable");

  assert.throws(() => verificationTool.schema.parse({ checks: [] }));
  const verificationArgs = verificationTool.schema.parse({
    checks: [{
      id: "lint",
      kind: "command",
      description: "Run lint independently",
      command: "pnpm lint",
      cwd: "."
    }]
  });
  const verificationExecution = runnable(await verificationTool.resolveExecution(verificationArgs));
  assert.deepEqual(verificationExecution.accesses, []);
  assert.deepEqual(await verificationExecution.execute({ toolCallId: "verification-1" }), {
    checks: [{
      id: "lint",
      kind: "command",
      description: "Run lint independently",
      command: "pnpm lint",
      cwd: "."
    }]
  });
  assert.deepEqual(store.listChecks(), [{
    id: "lint",
    kind: "command",
    description: "Run lint independently",
    command: "pnpm lint",
    cwd: "."
  }]);
}

function findTool(tools: readonly Tool<unknown, unknown>[], name: string): Tool<unknown, unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
