import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunOptions, AgentSession, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentPermissionRequest, AgentSessionEvent, AgentTurnOutcome } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { AgentAttemptExecutor } from "../src/harness/AgentAttemptExecutor.js";
import { compileTaskContract } from "../src/harness/TaskContractCompiler.js";
import { TaskRunStore } from "../src/harness/TaskRunStore.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { DurableTaskExecutionService } from "../src/runtime/DurableTaskExecutionService.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { ExecutionService } from "../src/runtime/ExecutionService.js";

await testIncompleteAttemptAutomaticallyContinues();
await testChatDoesNotCreateDurableTask();
await testRunDoesNotRouteByNaturalLanguageKeywords();
await testExecutionBridgesCliPermission();
await testExecutionCleansPermissionListenerWhenSubmitFails();
await testExecutionUsesUnifiedPromptBoundary();
await testInternalAttemptPromptStaysOutOfPublicMessage();
await testAttemptEvidenceIsBounded();
await testRemainingStepBudgetCapsNextAttempt();
await testHardStepLimitCapsLegacyDurableAttempt();
await testTaskAttemptBudgetIsNotCompletion();
await testBudgetExhaustionPreservesAgentFailure();
await testCodeTaskRequiresMutationEvenWhenChecksPass();
await testCodeTaskCompletesWithWorkspaceMutationAndIndependentChecks();
await testContinuationReusesDurableAcceptanceCriteria();

async function testIncompleteAttemptAutomaticallyContinues(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-retry-"));
  try {
    const store = await TaskRunStore.open(root);
    const inputs: string[] = [];
    const modelInputs: Array<string | undefined> = [];
    const remembered: Array<{ task: string; answer: string }> = [];
    let attempts = 0;
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (input, options): AsyncGenerator<AgentSessionEvent> {
      inputs.push(input);
      modelInputs.push(options.modelInput);
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
    const execution = await service.execute({
      input: "finish the requested task",
      signal: new AbortController().signal
    });
    const outcome = execution.turn;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.steps, 35);
    assert.equal(attempts, 2);
    assert.equal(inputs[0], "finish the requested task");
    assert.equal(inputs[1], "finish the requested task");
    assert.equal(modelInputs[0], "finish the requested task");
    assert.match(modelInputs[1] ?? "", /Continue the same project-level task autonomously/u);
    assert.deepEqual(remembered, [{ task: "finish the requested task", answer: "verified done" }]);

    const task = await store.get(execution.runId);
    assert.equal(task.status, "completed");
    assert.equal(task.attempts.length, 2);
    assert.equal(task.attempts[0]?.status, "incomplete");
    assert.equal(task.attempts[1]?.verifierEvidence.every((evidence) => evidence.passed), true);
    assert.equal(task.contract.plan.every((item) => !item.required || item.status === "completed"), true);
    assert.equal(task.evidence.some((evidence) => evidence.kind === "cleanup"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testChatDoesNotCreateDurableTask(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-chat-"));
  try {
    const store = await TaskRunStore.open(root);
    const modes: Array<AgentRunOptions["mode"]> = [];
    const runtime = new InteractiveAgentRuntime(fakeRuntime(root, store, async function* (_input, options): AsyncGenerator<AgentSessionEvent> {
      modes.push(options.mode);
      yield done({ status: "completed", stopReason: "completion_gate", finishReason: "stop", steps: 1, output: "direct answer" });
    }));

    const outcome = await runtime.submitPrompt("回答一个问题").completion;
    assert.equal(outcome.status, "completed");
    assert.deepEqual(modes, ["chat"]);
    assert.equal((await store.list()).length, 0);
    await runtime.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testRunDoesNotRouteByNaturalLanguageKeywords(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-unified-run-"));
  try {
    const store = await TaskRunStore.open(root);
    const prompts: string[] = [];
    const modes: Array<AgentRunOptions["mode"]> = [];
    let attemptCalls = 0;
    const commandRuntime = fakeRuntime(root, store, async function* (input, options): AsyncGenerator<AgentSessionEvent> {
      prompts.push(input);
      modes.push(options.mode);
      const suffix = String(prompts.length);
      yield {
        type: "tool.started",
        toolCallId: `read-${suffix}`,
        tool: "read_file",
        args: { path: "README.md" }
      };
      yield {
        type: "tool.completed",
        toolCallId: `read-${suffix}`,
        tool: "read_file",
        result: { content: "project" }
      };
      yield {
        type: "tool.started",
        toolCallId: `status-${suffix}`,
        tool: "git_status",
        args: {}
      };
      yield {
        type: "tool.completed",
        toolCallId: `status-${suffix}`,
        tool: "git_status",
        result: { clean: true }
      };
      yield done({
        status: "completed",
        stopReason: "completion_gate",
        finishReason: "stop",
        steps: 3,
        output: "ordinary agent loop completed"
      });
    });
    commandRuntime.agent.runAttempt = async function* (): AsyncGenerator<AgentSessionEvent> {
      attemptCalls += 1;
      yield done({
        status: "failed",
        stopReason: "provider_error",
        steps: 0,
        output: "",
        error: "durable attempt must not be used"
      });
    };

    const service = new ExecutionService(commandRuntime);
    const inputs = [
      "修改登录流程并修复测试",
      "start the project and fix the health check",
      "先查看仓库现状，再根据实际结果完成后续步骤"
    ];
    for (const input of inputs) {
      const result = await service.execute({ input, signal: new AbortController().signal });
      assert.equal(result.turn.status, "completed");
      assert.equal(result.turn.output, "ordinary agent loop completed");
    }

    assert.deepEqual(prompts, inputs);
    assert.deepEqual(modes, ["chat", "chat", "chat"]);
    assert.equal(attemptCalls, 0);
    assert.equal((await store.list()).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionBridgesCliPermission(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-permission-"));
  try {
    const store = await TaskRunStore.open(root);
    const request: AgentPermissionRequest = {
      toolCallId: "write-call",
      tool: "write_file",
      toolName: "write_file",
      title: "Write file",
      details: "Write feature.ts",
      requireFullYes: false,
      actionType: "write",
      riskLevel: "medium",
      targetPath: "feature.ts",
      sessionId: "session-1",
      projectRoot: root
    };
    const runtime = fakeRuntime(root, store, async function* (_input, options): AsyncGenerator<AgentSessionEvent> {
      const result = await options.confirmPermission?.(request);
      assert.equal(result?.approved, true);
      yield done({
        status: "completed",
        stopReason: "completion_gate",
        finishReason: "stop",
        steps: 2,
        output: "permission accepted"
      });
    });
    const observed: AgentPermissionRequest[] = [];
    const result = await new ExecutionService(runtime).execute({
      input: "更新 feature.ts",
      signal: new AbortController().signal,
      confirmPermission: async (pending) => {
        observed.push(pending);
        return { approved: true, scope: "once" };
      }
    });

    assert.equal(result.turn.status, "completed");
    assert.equal(observed[0]?.toolName, "write_file");
    assert.equal(observed[0]?.sessionId, "session-1");
    assert.equal(observed[0]?.projectRoot, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionCleansPermissionListenerWhenSubmitFails(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-listener-"));
  try {
    const store = await TaskRunStore.open(root);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const request: AgentPermissionRequest = {
      toolCallId: "write-after-busy",
      tool: "write_file",
      toolName: "write_file",
      title: "Write file",
      details: "Write after the busy run.",
      requireFullYes: false,
      actionType: "write",
      riskLevel: "medium",
      targetPath: "feature.ts",
      sessionId: "session-1",
      projectRoot: root
    };
    const runtime = fakeRuntime(root, store, async function* (input, options): AsyncGenerator<AgentSessionEvent> {
      if (input === "first") await firstGate;
      if (input === "third") {
        const permission = await options.confirmPermission?.(request);
        assert.equal(permission?.approved, true);
      }
      yield done({
        status: "completed",
        stopReason: "completion_gate",
        steps: 1,
        output: input
      });
    });
    const service = new ExecutionService(runtime);
    const first = service.execute({ input: "first", signal: new AbortController().signal });
    let stalePermissionCalls = 0;
    await assert.rejects(
      service.execute({
        input: "second",
        signal: new AbortController().signal,
        confirmPermission: async () => {
          stalePermissionCalls += 1;
          return { approved: true, scope: "once" };
        }
      }),
      /runtime.*busy/u
    );
    releaseFirst();
    await first;

    let currentPermissionCalls = 0;
    const third = await service.execute({
      input: "third",
      signal: new AbortController().signal,
      confirmPermission: async () => {
        currentPermissionCalls += 1;
        return { approved: true, scope: "once" };
      }
    });
    assert.equal(third.turn.status, "completed");
    assert.equal(stalePermissionCalls, 0);
    assert.equal(currentPermissionCalls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testExecutionUsesUnifiedPromptBoundary(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-boundary-"));
  try {
    const store = await TaskRunStore.open(root);
    let promptCalls = 0;
    let attemptCalls = 0;
    const runtime = fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield done({ status: "completed", stopReason: "model_stop", steps: 1, output: "unused" });
    });
    runtime.agent.prompt = async function* (): AsyncGenerator<AgentSessionEvent> {
      promptCalls += 1;
      yield done({ status: "completed", stopReason: "completion_gate", steps: 1, output: "wrong boundary" });
    };
    runtime.agent.runAttempt = async function* (): AsyncGenerator<AgentSessionEvent> {
      attemptCalls += 1;
      yield done({ status: "completed", stopReason: "model_stop", steps: 1, output: "direct attempt" });
    };

    const result = await new ExecutionService(runtime).execute({
      input: "回答一个简单问题",
      signal: new AbortController().signal
    });
    assert.equal(result.turn.output, "wrong boundary");
    assert.equal(promptCalls, 1);
    assert.equal(attemptCalls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testInternalAttemptPromptStaysOutOfPublicMessage(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-public-input-"));
  try {
    const store = await TaskRunStore.open(root);
    const calls: Array<{ input: string; modelInput?: string }> = [];
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (input, options): AsyncGenerator<AgentSessionEvent> {
      calls.push({ input, modelInput: options.modelInput });
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 1,
        output: "已处理"
      });
    }, 1));
    await service.execute({ input: "修复这个函数", signal: new AbortController().signal });
    assert.equal(calls[0]?.input, "修复这个函数");
    assert.match(calls[0]?.modelInput ?? "", /This is a verifier-driven task/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAttemptEvidenceIsBounded(): Promise<void> {
  const agent = {
    async *runAttempt(): AsyncGenerator<AgentSessionEvent> {
      yield {
        type: "tool.started",
        toolCallId: "large-command",
        tool: "run_command",
        args: { command: "pnpm test", padding: "x".repeat(100_000) }
      };
      yield {
        type: "tool.completed",
        toolCallId: "large-command",
        tool: "run_command",
        result: { status: "completed", exitCode: 0, stdout: "y".repeat(100_000) }
      };
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
    task: compileTaskContract({
      objective: "test",
      taskType: "conversation",
      acceptanceCriteria: [],
      verificationMode: "model_only"
    })
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
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (_input, options): AsyncGenerator<AgentSessionEvent> {
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

    const outcome = (await service.execute({
      input: "finish within forty steps",
      signal: new AbortController().signal
    })).turn;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.steps, 40);
    assert.deepEqual(attemptCaps, [32, 8]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testHardStepLimitCapsLegacyDurableAttempt(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-hard-limit-"));
  try {
    const store = await TaskRunStore.open(root);
    const attemptCaps: Array<number | undefined> = [];
    const runtime = fakeRuntime(root, store, async function* (_input, options): AsyncGenerator<AgentSessionEvent> {
      attemptCaps.push(options.maxSteps);
      yield done({
        status: "completed",
        stopReason: "completion_gate",
        finishReason: "stop",
        steps: 1,
        output: "completed under the hard limit"
      });
    }, 1);
    runtime.config.agent.hardStepLimit = 8;
    runtime.config.agent.maxSteps = 32;

    const outcome = (await createDurableExecutionService(store, runtime).execute({
      input: "answer without exceeding the configured hard limit",
      signal: new AbortController().signal
    })).turn;

    assert.equal(outcome.status, "completed");
    assert.deepEqual(attemptCaps, [8]);
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
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      attempts += 1;
      yield done({
        status: "incomplete",
        stopReason: "step_limit",
        finishReason: "tool-calls",
        steps: 32,
        output: `partial-${String(attempts)}`
      });
    }, 2, remembered));
    const execution = await service.execute({
      input: "implement a larger feature",
      signal: new AbortController().signal
    });
    const outcome = execution.turn;
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stopReason, "budget_exhausted");
    assert.equal(attempts, 2);
    assert.deepEqual(remembered, [], "budget-exhausted tasks must not enter successful memory");

    const task = await store.get(execution.runId);
    assert.equal(task.status, "budget_exhausted");
    assert.match(task.terminalReason ?? "", /budget exhausted/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testBudgetExhaustionPreservesAgentFailure(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-failure-detail-"));
  try {
    const store = await TaskRunStore.open(root);
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield done({
        status: "failed",
        stopReason: "provider_error",
        finishReason: "error",
        steps: 2,
        output: "",
        error: "Upstream stream reset before the terminal response."
      });
    }, 1));

    const outcome = (await service.execute({
      input: "回答这个问题",
      signal: new AbortController().signal
    })).turn;
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stopReason, "budget_exhausted");
    assert.equal(outcome.error, "Upstream stream reset before the terminal response.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCodeTaskRequiresMutationEvenWhenChecksPass(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-plan-gate-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { typecheck: "node -e 'process.exit(0)'" }
    }));
    const store = await TaskRunStore.open(root);
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 1,
        output: "claimed complete"
      });
    }, 1));

    const execution = await service.execute({
      input: "修复这个函数",
      signal: new AbortController().signal,
      confirmPermission: approveVerificationCommand
    });
    const outcome = execution.turn;
    assert.equal(outcome.status, "incomplete");
    assert.equal(outcome.stopReason, "budget_exhausted");
    const task = await store.get(execution.runId);
    assert.equal(task.contract.plan.find((item) => item.id === "implement")?.status, "pending");
    assert.equal(task.contract.plan.find((item) => item.id === "verify")?.status, "blocked");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCodeTaskCompletesWithWorkspaceMutationAndIndependentChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-contract-success-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { typecheck: "node -e 'process.exit(0)'" }
    }));
    const store = await TaskRunStore.open(root);
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield {
        type: "tool.started",
        toolCallId: "write-feature",
        tool: "write_file",
        args: { path: "feature.ts", content: "export const feature = true;\n" }
      };
      await fs.writeFile(path.join(root, "feature.ts"), "export const feature = true;\n");
      yield {
        type: "tool.completed",
        toolCallId: "write-feature",
        tool: "write_file",
        result: { path: "feature.ts" }
      };
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 2,
        output: "implemented"
      });
    }, 1));

    const execution = await service.execute({
      input: "修复这个函数",
      signal: new AbortController().signal,
      confirmPermission: approveVerificationCommand
    });
    const outcome = execution.turn;
    assert.equal(outcome.status, "completed");
    const task = await store.get(execution.runId);
    assert.equal(task.contract.plan.every((item) => !item.required || item.status === "completed"), true);
    assert.equal(task.evidence.some((evidence) => evidence.kind === "verification" && evidence.passed), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testContinuationReusesDurableAcceptanceCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-runtime-resume-"));
  try {
    const store = await TaskRunStore.open(root);
    await fs.writeFile(path.join(root, "ready.txt"), "ready\n");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { build: "node -e 'process.exit(0)'" }
    }));
    await store.create({
      taskRunId: "previous-task",
      contract: compileTaskContract({
        objective: "finish the previous project task",
        taskType: "conversation",
        acceptanceCriteria: [
          { id: "ready-file", kind: "file_exists", path: "ready.txt" },
          { id: "prior-build", kind: "command_succeeded", command: "pnpm build" }
        ],
        verificationMode: "deterministic",
        pendingTodo: ["verify ready.txt and prior build evidence"]
      }),
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
    const service = createDurableExecutionService(store, fakeRuntime(root, store, async function* (): AsyncGenerator<AgentSessionEvent> {
      yield done({
        status: "completed",
        stopReason: "model_stop",
        finishReason: "stop",
        steps: 1,
        output: "checked"
      });
    }));

    const execution = await service.execute({
      input: "继续",
      signal: new AbortController().signal,
      confirmPermission: approveVerificationCommand
    });
    const outcome = execution.turn;
    assert.equal(outcome.status, "completed");
    const resumed = await store.get(execution.runId);
    assert.equal(resumed.contract.acceptanceCriteria[0]?.id, "ready-file");
    assert.equal(resumed.contract.acceptanceCriteria[1]?.id, "prior-build");
    assert.equal(resumed.contract.pendingTodo.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeRuntime(
  workspaceRoot: string,
  _taskRuns: TaskRunStore,
  run: (input: string, options: AgentRunOptions) => AsyncGenerator<AgentSessionEvent>,
  maxAttempts = 3,
  remembered: Array<{ task: string; answer: string }> = [],
  maxTaskSteps = maxAttempts * 32
): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot,
    sessionId: "session-1",
    sessionFile: path.join(workspaceRoot, ".biny", "sessions", "session-1.jsonl"),
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    prompt: run,
    runAttempt: run,
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
    extensionReport: () => "",
    setSubagentParentRunId: () => undefined,
    cancelSubagentTasks: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function createDurableExecutionService(
  store: TaskRunStore,
  commandRuntime: CommandRuntime
): DurableTaskExecutionService {
  return new DurableTaskExecutionService(commandRuntime, store);
}

function done(outcome: AgentTurnOutcome): AgentSessionEvent {
  return { type: "done", content: outcome.output, usage: outcome.usage, outcome };
}

async function approveVerificationCommand(): Promise<{
  approved: true;
  scope: "once";
  confirmation: "yes";
}> {
  return {
    approved: true,
    scope: "once",
    confirmation: "yes"
  };
}
