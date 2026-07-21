import assert from "node:assert/strict";
import { TaskAttemptLoop, type TaskHarnessEvent } from "../src/harness/TaskAttemptLoop.js";

await testVerifierPassesFirstAttempt();
await testRetryCarriesVerifierFeedback();
await testStepBudgetStopsFurtherAttempts();
await testWallBudgetStopsAfterOverrun();
await testTokenBudgetStopsContinuation();
await testCostBudgetStopsContinuation();
await testAbortDecisionEmitsOneTerminalEvent();
await testInvalidBudgetDoesNotExecute();

async function testVerifierPassesFirstAttempt(): Promise<void> {
  const events: TaskHarnessEvent[] = [];
  let executions = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 3 },
    execute: async () => {
      executions += 1;
      return { output: "done", runtimeSteps: 1 };
    },
    verify: async () => ({ passed: true, summary: "All checks passed." }),
    onEvent: (event) => events.push(event)
  });
  const result = await loop.run("task");
  assert.equal(result.status, "passed");
  assert.equal(executions, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(events.filter((event) => event.type === "task.terminal").length, 1);
}

async function testRetryCarriesVerifierFeedback(): Promise<void> {
  const feedback: Array<string | undefined> = [];
  const remainingSteps: Array<number | undefined> = [];
  let executions = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 3, maxRuntimeSteps: 5 },
    execute: async (context) => {
      executions += 1;
      feedback.push(context.feedback);
      remainingSteps.push(context.remainingRuntimeSteps);
      return { output: `output-${String(context.attemptNumber)}`, runtimeSteps: 2 };
    },
    verify: async (context) => ({ passed: context.attemptNumber === 2, summary: `check-${String(context.attemptNumber)}` }),
    feedbackPrompt: async (context) => `fix ${context.verification.summary}`
  });
  const result = await loop.run("task");
  assert.equal(result.status, "passed");
  assert.equal(executions, 2);
  assert.deepEqual(feedback, [undefined, "fix check-1"]);
  assert.deepEqual(remainingSteps, [5, 3]);
}

async function testStepBudgetStopsFurtherAttempts(): Promise<void> {
  let executions = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 4, maxRuntimeSteps: 2 },
    execute: async () => {
      executions += 1;
      return { output: "not enough", runtimeSteps: 2 };
    },
    verify: async () => ({ passed: false, summary: "needs another attempt" })
  });
  const result = await loop.run("task");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(executions, 1);
  assert.equal(result.runtimeStepsUsed, 2);
}

async function testWallBudgetStopsAfterOverrun(): Promise<void> {
  let now = 0;
  let verifierCalls = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 2, maxWallTimeMs: 100 },
    now: () => now,
    execute: async () => {
      now = 101;
      return { output: "late", runtimeSteps: 1 };
    },
    verify: async () => {
      verifierCalls += 1;
      return { passed: true, summary: "too late" };
    }
  });
  const result = await loop.run("task");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(verifierCalls, 0);
}

async function testTokenBudgetStopsContinuation(): Promise<void> {
  let executions = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 3, maxTotalTokens: 10 },
    execute: async () => {
      executions += 1;
      return {
        output: "not verified",
        runtimeSteps: 1,
        usage: {
          operation: "agent",
          modelAlias: "test",
          provider: "test",
          model: "test",
          totalTokens: 10,
          pricingKnown: false
        }
      };
    },
    verify: async () => ({ passed: false, summary: "continue" })
  });
  const result = await loop.run("task");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.totalTokensUsed, 10);
  assert.equal(executions, 1);
}

async function testCostBudgetStopsContinuation(): Promise<void> {
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 3, maxCostUsd: 0.01 },
    execute: async () => ({
      output: "not verified",
      runtimeSteps: 1,
      usage: {
        operation: "agent",
        modelAlias: "test",
        provider: "test",
        model: "test",
        costUsd: 0.01,
        pricingKnown: true
      }
    }),
    verify: async () => ({ passed: false, summary: "continue" })
  });
  const result = await loop.run("task");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.costUsdUsed, 0.01);
}

async function testAbortDecisionEmitsOneTerminalEvent(): Promise<void> {
  const events: TaskHarnessEvent[] = [];
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 3 },
    execute: async () => ({ output: "failed", runtimeSteps: 1 }),
    verify: async () => ({ passed: false, summary: "cannot satisfy" }),
    decide: () => "abort",
    onEvent: (event) => events.push(event)
  });
  const result = await loop.run("task");
  assert.equal(result.status, "aborted");
  assert.equal(events.filter((event) => event.type === "task.terminal").length, 1);
}

async function testInvalidBudgetDoesNotExecute(): Promise<void> {
  let executions = 0;
  const loop = new TaskAttemptLoop({
    budget: { maxAttempts: 0 },
    execute: async () => {
      executions += 1;
      return { output: "unexpected", runtimeSteps: 1 };
    },
    verify: async () => ({ passed: true, summary: "unexpected" })
  });
  const result = await loop.run("task");
  assert.equal(result.status, "failed");
  assert.equal(executions, 0);
}
