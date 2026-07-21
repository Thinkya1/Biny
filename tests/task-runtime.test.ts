import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunOptions, AgentSession, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent, AgentTurnOutcome } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { AgentAttemptExecutor } from "../src/harness/AgentAttemptExecutor.js";
import { TaskRunStore } from "../src/harness/TaskRunStore.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

await testIncompleteAttemptAutomaticallyContinues();
await testAttemptEvidenceIsBounded();
await testRemainingStepBudgetCapsNextAttempt();
await testTaskAttemptBudgetIsNotCompletion();
await testContinuationReusesDurableAcceptanceCriteria();

async function testIncompleteAttemptAutomaticallyContinues(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-retry-"));
  try {
    const store = await TaskRunStore.open(root);
    const inputs: string[] = [];
    const remembered: Array<{ task: string; answer: string }> = [];
    let attempts = 0;
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, store, async function* (input): AsyncGenerator<AgentSessionEvent> {
      inputs.push(input);
      attempts += 1;
      yield done(attempts === 1
        ? {
            status: "incomplete",
            stopReason: "step_limit",
            finishReason: "tool-calls",
            steps: 32,
            output: "still working"
          }
        : {
            status: "completed",
            stopReason: "model_stop",
            finishReason: "stop",
            steps: 3,
            output: "verified done"
          });
    }, 3, remembered));
    const events: AgentHostEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    const submitted = runtime.submitPrompt("implement the requested feature");
    const outcome = await submitted.completion;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.steps, 35);
    assert.equal(attempts, 2);
    assert.match(inputs[1] ?? "", /Continue the same project-level task autonomously/u);
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(events.some((event) => event.type === "run.incomplete"), false);
    assert.deepEqual(remembered, [{ task: "implement the requested feature", answer: "verified done" }]);

    const task = await store.get(submitted.runId);
    assert.equal(task.status, "completed");
    assert.equal(task.attempts.length, 2);
    assert.equal(task.attempts[0]?.status, "incomplete");
    assert.equal(task.attempts[1]?.verifierEvidence.every((evidence) => evidence.passed), true);
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAttemptEvidenceIsBounded(): Promise<void> {
  const agent = {
    async *runSdk(): AsyncGenerator<AgentSessionEvent> {
      yield {
        type: "tool-started",
        toolCallId: "large-command",
        tool: "run_command",
        args: { command: "pnpm test", padding: "x".repeat(100_000) }
      };
      yield {
        type: "sdk",
        part: {
          type: "tool-result",
          toolCallId: "large-command",
          toolName: "run_command",
          input: {},
          output: { status: "completed", exitCode: 0, stdout: "y".repeat(100_000) }
        }
      } as AgentSessionEvent;
      yield done({ status: "completed", stopReason: "model_stop", steps: 2, output: "done" });
    }
  };
  const executor = new AgentAttemptExecutor({
    agent: agent as unknown as AgentSession,
    runOptions: () => ({})
  });
  const execution = await executor.execute({
    taskRunId: "task",
    attemptId: "attempt",
    attemptNumber: 1,
    task: { objective: "test", acceptanceCriteria: [] }
  });
  assert.ok(JSON.stringify(execution.attemptToolEvidence).length < 20_000);
  const result = execution.attemptToolEvidence[0]?.result as { exitCode?: number } | undefined;
  assert.equal(result?.exitCode, 0);
}

async function testRemainingStepBudgetCapsNextAttempt(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-remaining-"));
  try {
    const store = await TaskRunStore.open(root);
    const attemptCaps: Array<number | undefined> = [];
    let attempts = 0;
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, store, async function* (_input, options): AsyncGenerator<AgentSessionEvent> {
      attemptCaps.push(options.maxSteps);
      attempts += 1;
      yield done(attempts === 1
        ? {
            status: "incomplete",
            stopReason: "step_limit",
            finishReason: "tool-calls",
            steps: 32,
            output: "continue"
          }
        : {
            status: "completed",
            stopReason: "model_stop",
            finishReason: "stop",
            steps: 8,
            output: "done within remaining budget"
          });
    }, 3, [], 40));

    const outcome = await runtime.submitPrompt("finish within forty steps").completion;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.steps, 40);
    assert.deepEqual(attemptCaps, [32, 8]);
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testTaskAttemptBudgetIsNotCompletion(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-budget-"));
  try {
    const store = await TaskRunStore.open(root);
    let attempts = 0;
    const remembered: Array<{ task: string; answer: string }> = [];
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      attempts += 1;
      yield done({
        status: "incomplete",
        stopReason: "step_limit",
        finishReason: "tool-calls",
        steps: 32,
        output: `partial-${String(attempts)}`
      });
    }, 2, remembered));
    const events: AgentHostEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    const submitted = runtime.submitPrompt("implement a larger feature");
    const outcome = await submitted.completion;
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stopReason, "budget_exhausted");
    assert.equal(attempts, 2);
    assert.equal(events.some((event) => event.type === "run.completed"), false);
    assert.equal(events.filter((event) => event.type === "run.incomplete").length, 1);
    assert.deepEqual(remembered, [], "budget-exhausted tasks must not enter successful memory");

    const task = await store.get(submitted.runId);
    assert.equal(task.status, "budget_exhausted");
    assert.match(task.terminalReason ?? "", /budget exhausted/iu);
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testContinuationReusesDurableAcceptanceCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-resume-"));
  try {
    const store = await TaskRunStore.open(root);
    await fs.writeFile(path.join(root, "ready.txt"), "ready\n");
    await store.create({
      taskRunId: "previous-task",
      request: {
        objective: "finish the previous project task",
        acceptanceCriteria: [
          { id: "ready-file", kind: "file_exists", path: "ready.txt" },
          { id: "prior-build", kind: "command_succeeded", command: "pnpm build" }
        ],
        pendingTodo: ["verify ready.txt and prior build evidence"]
      },
      budget: { maxAttempts: 1 }
    });
    await store.markRunning("previous-task");
    await store.startAttempt("previous-task", { attemptId: "previous-attempt", attemptNumber: 1 });
    await store.completeAttempt("previous-task", "previous-attempt", {
      status: "incomplete",
      runtimeSteps: 1,
      stopReason: "step_limit",
      toolEvidence: [{
        toolCallId: "previous-build-call",
        tool: "run_command",
        args: { command: "pnpm build" },
        result: { status: "completed", exitCode: 0 },
        observedAt: new Date().toISOString()
      }]
    });
    await store.finish("previous-task", "budget_exhausted", "Previous attempt budget exhausted.");
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 1,
        output: "checked"
      });
    }));

    const submitted = runtime.submitPrompt("继续");
    const outcome = await submitted.completion;
    assert.equal(outcome.status, "completed");
    const resumed = await store.get(submitted.runId);
    assert.equal(resumed.acceptanceCriteria[0]?.id, "ready-file");
    assert.equal(resumed.acceptanceCriteria[1]?.id, "prior-build");
    assert.equal(resumed.pendingTodo.length, 0);
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeRuntime(
  workspaceRoot: string,
  taskRuns: TaskRunStore,
  runSdk: (input: string, options: AgentRunOptions) => AsyncGenerator<AgentSessionEvent>,
  maxAttempts = 3,
  remembered: Array<{ task: string; answer: string }> = [],
  maxTaskSteps = maxAttempts * 32
): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot,
    sessionId: "session-1",
    sessionFile: path.join(workspaceRoot, ".agent", "sessions", "session-1.jsonl"),
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    runSdk,
    contextStatus: async () => ({
      loadedInstructions: [],
      instructionBytes: 0,
      instructionCapBytes: 1,
      snapshotDirty: false,
      repoMapDirty: false,
      repoMapEntries: 0,
      activePaths: [],
      recentActivity: { paths: [], summaries: [] },
      compaction: { summaryPresent: false, compactedMessages: 0 },
      budget: { maxTokens: 1, usedTokens: 0, omitted: [], autoCompacted: false },
      memoryEnabled: false,
      memoryTopics: []
    }),
    rememberSuccessfulTask: (task: string, answer: string) => remembered.push({ task, answer }),
    recordError: () => undefined,
    close: async () => undefined
  };
  return {
    workspaceRoot,
    persistenceRoot: workspaceRoot,
    config: {
      ...defaultConfig,
      agent: {
        ...defaultConfig.agent,
        maxSteps: 32,
        maxAttempts,
        maxTaskSteps,
        maxWallTimeMs: 60_000,
        maxTotalTokens: 100_000
      }
    },
    agent,
    managedProcesses: { listProcesses: async () => [], close: async () => [] },
    taskRuns,
    extensionReport: () => "",
    setSubagentParentRunId: () => undefined,
    cancelSubagentTasks: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function done(outcome: AgentTurnOutcome): AgentSessionEvent {
  return { type: "done", content: outcome.output, usage: outcome.usage, outcome };
}
