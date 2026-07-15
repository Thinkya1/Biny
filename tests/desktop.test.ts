import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunOptions, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { loadConfig } from "../src/config/loader.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import {
  canNavigateBack,
  canNavigateForward,
  createNavigationState,
  moveNavigation,
  pushNavigation,
  replaceNavigation
} from "../src/desktop/renderer/src/navigationHistory.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { listSessionSummaries } from "../src/session/events.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

await testInteractiveRuntimeProtocol();
await testInteractiveRuntimeAbort();
await testDraftSessionsDoNotReachTheSessionList();
await testDesktopModelConfiguration();
testHistoricalAbortProjection();
testHistoricalUsageProjection();
testHistoricalToolProjection();
testLiveTimelineProjection();
testDesktopNavigationHistory();

async function testInteractiveRuntimeProtocol(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let resolvePermission!: (event: Extract<AgentHostEvent, { type: "permission.requested" }>) => void;
  const permissionRequested = new Promise<Extract<AgentHostEvent, { type: "permission.requested" }>>((resolve) => {
    resolvePermission = resolve;
  });
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "permission.requested") resolvePermission(event);
  });

  const submitted = runtime.submitPrompt("modify file");
  const permission = await permissionRequested;
  assert.equal(permission.toolCallId, "tool-1");
  runtime.answerPermission(permission.requestId, { approved: true, scope: "once" });
  await submitted.completion;

  assert.deepEqual(events.map((event) => event.type), [
    "message.user",
    "run.started",
    "reasoning.started",
    "reasoning.completed",
    "tool.started",
    "reasoning.status",
    "permission.requested",
    "permission.resolved",
    "tool.completed",
    "file.changed",
    "assistant.delta",
    "assistant.completed",
    "context.updated",
    "run.completed"
  ]);
  assert.ok(events.every((event) => event.sessionId === "session-1" && event.runId && event.timestamp));
  await runtime.close();
}

async function testInteractiveRuntimeAbort(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let started!: () => void;
  const runStarted = new Promise<void>((resolve) => { started = resolve; });
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "run.started") started();
  });
  const submitted = runtime.submitPrompt("cancel");
  await runStarted;
  runtime.cancelCurrentRun();
  await submitted.completion;
  assert.equal(events.at(-1)?.type, "run.aborted");
  await runtime.close();
}

async function testDraftSessionsDoNotReachTheSessionList(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-draft-session-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const draft = new SessionRecorder(workspaceRoot, "draft");
    await assert.rejects(access(draft.filePath));
    await draft.close();
    await writeFile(sessionFilePath(workspaceRoot, "legacy-empty"), "");
    await writeFile(sessionFilePath(workspaceRoot, "legacy-error"), `${JSON.stringify({ type: "error", message: "No model available" })}\n`);
    assert.deepEqual(await listSessionSummaries(workspaceRoot), []);

    draft.record({ type: "user_message", content: "Create a project" });
    await draft.close();
    assert.deepEqual((await listSessionSummaries(workspaceRoot)).map((session) => session.fileName), ["draft.jsonl"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testDesktopModelConfiguration(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-config-"));
  try {
    const state = new DesktopStateStore(path.join(workspaceRoot, "desktop-state.json"));
    await state.load();
    const projects = new DesktopProjectService(state);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, () => undefined);
    const snapshot = await agents.saveModelConfiguration(project.id, {
      alias: "local-qwen",
      displayName: "本地 Qwen",
      providerAlias: "local",
      providerType: "ollama",
      model: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: undefined,
      apiKey: undefined,
      supportsTools: true,
      supportsThinking: false
    });
    const config = await loadConfig(workspaceRoot);
    assert.equal(config.defaultModel, "local-qwen");
    assert.equal(config.providers.local?.type, "ollama");
    assert.equal(config.models["local-qwen"]?.model, "qwen3:8b");
    assert.equal(snapshot.models.some((model) => model.alias === "local-qwen"), true);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function testHistoricalAbortProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "sleep", time: "2026-01-01T00:00:00.000Z" },
    { type: "tool_call", tool: "run_command", args: { command: "sleep 20" }, toolCallId: "tool-1", sequence: 1 },
    { type: "tool_result", tool: "run_command", result: { stdout: "", stderr: "Command interrupted.", exitCode: 1 }, toolCallId: "tool-1", sequence: 1 },
    { type: "error", message: "This operation was aborted" }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.status, "aborted");
  assert.equal(timeline[0]?.tools[0]?.status, "aborted");
}

function testHistoricalUsageProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "hello" },
    {
      type: "assistant_message",
      content: "hi",
      usage: {
        operation: "agent",
        modelAlias: "primary",
        provider: "openai",
        model: "gpt-test",
        totalTokens: 42,
        pricingKnown: false
      }
    }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.model?.alias, "primary");
  assert.equal(timeline[0]?.model?.label, "openai/gpt-test");
  assert.equal(timeline[0]?.usage?.totalTokens, 42);
}

function testHistoricalToolProjection(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "read" },
    { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "tool" },
    { type: "tool_result", tool: "read_file", result: { path: "src/index.ts", content: "hello" }, toolCallId: "tool" }
  ], []);
  assert.equal(timeline[0]?.tools[0]?.path, "src/index.ts");
  assert.deepEqual(timeline[0]?.tools[0]?.display, { kind: "file_io", operation: "read", path: "src/index.ts" });
}

function testLiveTimelineProjection(): void {
  const base = { sessionId: "session", runId: "run", timestamp: "2026-01-01T00:00:00.000Z" };
  const live: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "message", content: "show diff" },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "git_diff", args: {} },
    { ...base, type: "diff.created", toolCallId: "tool", diff: "diff --git a/a.ts b/a.ts\n+const a = 1;" },
    { ...base, type: "tool.completed", toolCallId: "tool", tool: "git_diff", result: {}, durationMs: 20 },
    { ...base, type: "assistant.completed", messageId: "message", content: "done" },
    { ...base, type: "run.completed", durationMs: 30 }
  ];
  const timeline = buildSessionTimeline([], live);
  assert.equal(timeline[0]?.assistant, "done");
  assert.equal(timeline[0]?.tools[0]?.diff?.includes("a.ts"), true);
  assert.equal(timeline[0]?.status, "completed");
}

function testDesktopNavigationHistory(): void {
  const first = { projectId: "project", sessionId: "first" };
  const second = { projectId: "project", sessionId: "second" };
  const draft = { projectId: "project", sessionId: undefined };
  let state = createNavigationState();
  state = pushNavigation(state, first);
  state = pushNavigation(state, second);
  assert.equal(canNavigateBack(state), true);
  assert.equal(canNavigateForward(state), false);

  const back = moveNavigation(state, -1);
  assert.deepEqual(back.target, first);
  state = back.state;
  state = pushNavigation(state, draft);
  assert.equal(canNavigateForward(state), false);
  assert.deepEqual(state.entries, [first, draft]);
  state = replaceNavigation(state, second);
  assert.deepEqual(state.entries, [first, second]);
  assert.deepEqual(moveNavigation(state, 1).target, undefined);
}

function fakeCommandRuntime(): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot: "/tmp/project",
    sessionId: "session-1",
    sessionFile: "/tmp/project/.agent/sessions/session-1.jsonl",
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const context: ContextStatus = {
    loadedInstructions: [],
    instructionBytes: 0,
    instructionCapBytes: 10_000,
    snapshotRefreshedAt: undefined,
    snapshotDirty: false,
    repoMapRefreshedAt: undefined,
    repoMapDirty: false,
    repoMapEntries: 0,
    activePaths: [],
    recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: { maxTokens: 24_000, usedTokens: 10, omitted: [], autoCompacted: false, source: "estimated", measuredAt: undefined },
    memoryEnabled: false,
    memoryTopics: []
  };
  const request = {
    toolCallId: "tool-1",
    tool: "write_file",
    title: "Allow write",
    details: "Write a file",
    requireFullYes: false,
    actionType: "write",
    riskLevel: "medium"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    setPermissionMode: async () => undefined,
    listModels: () => [],
    switchModel: async () => ({ modelAlias: "test", provider: "test", modelLabel: "test/model", reasoningLabel: "Off", thinking: "off" as const }),
    async *runSdk(input: string, options: AgentRunOptions): AsyncGenerator<AgentSessionEvent> {
      yield { type: "status", status: "thinking" };
      if (input === "cancel") {
        if (!options.abortSignal?.aborted) {
          await new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        throw new Error("aborted");
      }
      yield { type: "tool-started", toolCallId: "tool-1", tool: "write_file", args: { path: "a.ts" }, display: { kind: "file_io", operation: "write", path: "a.ts" } };
      const result = await options.confirmPermission?.(request as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0]);
      yield { type: "permission-result", toolCallId: "tool-1", request: request as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0], result: result ?? { approved: false } };
      yield { type: "sdk", part: { type: "tool-result", toolCallId: "tool-1", toolName: "write_file", output: { path: "a.ts" } } as AgentSessionEvent & never };
      yield { type: "sdk", part: { type: "text-delta", id: "text", text: "done" } as AgentSessionEvent & never };
      yield { type: "done", content: "done" };
    },
    contextStatus: async () => context,
    recordError: () => undefined,
    close: async () => undefined
  };
  return {
    agent,
    close: async () => undefined
  } as unknown as CommandRuntime;
}
