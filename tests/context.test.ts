import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, ModelMessage } from "ai";
import { AgentSession } from "../src/agent/AgentSession.js";
import { ContextMemory, estimateMessageTokens } from "../src/agent/context/ContextMemory.js";
import { LocalMemory, redactSecrets } from "../src/agent/context/LocalMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { cloneModelMessages, messageReasoning, messageText } from "../src/agent/modelMessages.js";
import { buildSystemPrompt } from "../src/agent/prompts.js";
import type { AgentConfig } from "../src/config/schema.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { createLocalTelemetry } from "../src/observability/telemetry.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { maxSessionEventLineBytes, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { replaySession, sessionEventsToConversation } from "../src/session/replay.js";
import {
  deleteSessionFile,
  duplicateSessionFile,
  ensureAgentDirs,
  listSessionFiles,
  readSessionSnapshot,
  resolveSessionFile,
  sessionFilePath
} from "../src/session/store.js";
import { listSessionSummaries, parseSessionEvents, readSessionEvents, readStoredSessionEvents, repairSessionTailForAppend } from "../src/session/events.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { appendInputHistory, loadInputHistory } from "../src/tui/inputHistory.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";

class ContextTestModel {
  readonly requests: ModelMessage[][] = [];
  readonly model: LanguageModel = createContextTestModel(this);

  respond(messages: ModelMessage[]): string {
    this.requests.push(cloneModelMessages(messages));
    const prompt = messageText(messages.at(-1) ?? { role: "user", content: "" });
    if (prompt.includes("Extract one durable")) {
      return JSON.stringify({
        topic: "workflows",
        title: "Context refresh workflow",
        summary: "Refresh the workspace snapshot and RepoMap after a successful workspace write before the next turn.",
        decisions: ["Use deterministic paths instead of vector retrieval."],
        paths: ["src/agent/context/ContextMemory.ts"],
        keywords: ["context", "refresh", "workflow"]
      });
    }
    if (prompt.includes("Summarize this coding-agent")) {
      return JSON.stringify({
        goal: "Keep context bounded.",
        decisions: ["Use a structured handoff."],
        files: ["src/agent/context/ContextMemory.ts"],
        commandResults: ["Tests passed."],
        verification: ["Review the latest tool result."],
        todo: ["Continue the requested change."]
      });
    }
    return "ok";
  }
}

function createContextTestModel(provider: ContextTestModel): LanguageModel {
  const run = (prompt: unknown): string => provider.respond(promptToModelMessages(prompt));
  return {
    specificationVersion: "v3",
    provider: "context-test",
    modelId: "context-test",
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown }) => ({
      content: [{ type: "text", text: run(prompt) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: 0, outputTokens: 1 },
      warnings: []
    }),
    doStream: async ({ prompt }: { prompt: unknown }) => {
      const text = run(prompt);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "context-text" });
          controller.enqueue({ type: "text-delta", id: "context-text", delta: text });
          controller.enqueue({ type: "text-end", id: "context-text" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: 0, outputTokens: 1 } });
          controller.close();
        }
      });
      return { stream };
    }
  } as unknown as LanguageModel;
}

function promptToModelMessages(prompt: unknown): ModelMessage[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.map((message) => {
    const item = message as { role?: string; content?: unknown };
    const parts = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
    const text = typeof item.content === "string" ? item.content : parts
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => String(part.text ?? ""))
      .join("");
    if (item.role === "assistant") {
      return {
        role: "assistant",
        content: [
          ...(parts.filter((part) => part.type === "reasoning").map((part) => ({ type: "reasoning" as const, text: String(part.text ?? "") }))),
          ...(text ? [{ type: "text" as const, text }] : []),
          ...parts.filter((part) => part.type === "tool-call").map((part) => ({
            type: "tool-call" as const,
            toolCallId: String(part.toolCallId ?? ""),
            toolName: String(part.toolName ?? ""),
            input: part.input
          }))
        ]
      };
    }
    if (item.role === "tool") {
      const result = parts.find((part) => part.type === "tool-result");
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: String(result?.toolCallId ?? ""),
          toolName: String(result?.toolName ?? "tool"),
          output: { type: "text", value: JSON.stringify(result?.output ?? "") }
        }]
      };
    }
    return { role: item.role === "system" ? "system" : "user", content: text };
  });
}

async function main(): Promise<void> {
  testConversationBoundaryPrompt();
  await testInstructionHierarchyAndCap();
  await testInstructionLoadingUsesExplicitPaths();
  await testRepoMapExactCandidate();
  await testAutomaticContextRejectsExternalSymlinks();
  await testAutomaticContextSupportsSymlinkedWorkspaceRoot();
  await testBudgetAndCompaction();
  await testContextPreparationAbortStopsAutoCompaction();
  await testRestoreWithoutPersistedBudgetUsesHistoryEstimate();
  await testSessionReplayAndAgentResume();
  await testSessionPathBoundaries();
  await testSessionReadLimits();
  await testDeleteSessionReplacementRace();
  await testFailedCurrentSessionResumeKeepsRecorderUsable();
  await testTruncatedSessionTailAndDanglingToolRecovery();
  await testSessionAndToolDisplayRedaction();
  await testMemoryRedactionDedupAndWriter();
  await testMemoryQueueLifecycleAndUsagePersistence();
  await testMemoryStorageBoundaries();
  await testCredentialAndSymlinkBoundaries();
  await testToolWriteMarksSnapshotAndRepoMapDirty();
}

function testConversationBoundaryPrompt(): void {
  const prompt = buildSystemPrompt("qa");
  assert.match(prompt, /messages, tool calls, file reads, command results, plans, and approvals before the latest user message are inherited history/);
  assert.match(prompt, /Only the latest user message is the active task/);
  assert.match(prompt, /Never say "I just read\.\.\."/);
}

async function testInstructionHierarchyAndCap(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.md"), "ignored by override\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "AGENTS.override.md"), "nested override rule\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.initialize();
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);

    workspace.observeToolResult("read_file", { path: "src/example.ts" }, { path: "src/example.ts", content: "export {};" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/AGENTS.override.md"]);

    const capped = new WorkspaceContext(workspaceRoot, [], 10);
    await capped.initialize();
    assert.equal(capped.status().instructionBytes <= 10, true);
  });
}

async function testInstructionLoadingUsesExplicitPaths(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src", "feature"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "AGENTS.md"), "feature rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "entry.ts"), "export const entry = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.prepareTurn("inspect src/feature/entry.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);

    workspace.observeToolResult("read_file", { path: "src/feature/entry.ts" }, { path: "src/feature/entry.ts", content: "export const entry = true;" });
    await workspace.prepareTurn("explain the file");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md", "src/feature/AGENTS.md"]);
  });
}

async function testRepoMapExactCandidate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "import { createWorker } from './worker.js';\nexport function startAgent() { return createWorker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "worker.ts"), "export class Worker {}\nexport function createWorker() { return new Worker(); }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tests", "worker.test.ts"), "export function testWorker() {}\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [".agent"], 32 * 1024);
    const turn = await workspace.prepareTurn("startAgent");
    assert.equal(turn.repoMapCandidates[0]?.path, "src/index.ts");
    assert.equal(turn.repoMapCandidates[0]?.symbols.includes("startAgent"), true);
    assert.equal("content" in (turn.repoMapCandidates[0] ?? {}), false);
  });
}

async function testAutomaticContextRejectsExternalSymlinks(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-external-"));
    try {
      await fs.mkdir(path.join(externalRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "EXTERNAL_INSTRUCTION_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "entry.ts"), "export const ExternalRepoMapSecret = true;\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "README.md"), "EXTERNAL_README_SECRET\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "package.json"), JSON.stringify({ name: "external-package-secret" }), "utf8");
      await fs.writeFile(path.join(externalRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { externalSecret: true } }), "utf8");
      await fs.writeFile(path.join(externalRoot, "pnpm-lock.yaml"), "external-lock-secret\n", "utf8");
      await fs.writeFile(path.join(externalRoot, "src", "leak.ts"), "export const ExternalSrcTreeSecret = true;\n", "utf8");

      await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "safe workspace rule\n", "utf8");
      await fs.symlink(externalRoot, path.join(workspaceRoot, "linked"), "dir");
      await fs.symlink(path.join(externalRoot, "src"), path.join(workspaceRoot, "src"), "dir");
      for (const fileName of ["README.md", "package.json", "tsconfig.json", "pnpm-lock.yaml"]) {
        await fs.symlink(path.join(externalRoot, fileName), path.join(workspaceRoot, fileName), "file");
      }

      const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
      const turn = await workspace.prepareTurn("inspect linked/entry.ts ExternalRepoMapSecret");
      assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
      assert.equal(turn.instructions.some((instruction) => instruction.content.includes("EXTERNAL_INSTRUCTION_SECRET")), false);
      assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("ExternalRepoMapSecret")), false);
      assert.equal(turn.snapshot.context.packageManager, "unknown");
      assert.equal(turn.snapshot.context.packageJson, undefined);
      assert.equal(turn.snapshot.context.tsconfig, undefined);
      assert.equal(turn.snapshot.context.readme, undefined);
      assert.deepEqual(turn.snapshot.context.srcTree, []);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
}

async function testAutomaticContextSupportsSymlinkedWorkspaceRoot(): Promise<void> {
  if (process.platform === "win32") return;
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "alias root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "alias root readme\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "alias-root" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const AliasRootSymbol = true;\n", "utf8");
    const aliasRoot = path.join(workspaceRoot, "workspace-link");
    await fs.symlink(workspaceRoot, aliasRoot, "dir");

    const workspace = new WorkspaceContext(aliasRoot, [], 32 * 1024);
    const turn = await workspace.prepareTurn("find AliasRootSymbol in src/index.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);
    assert.equal(turn.instructions[0]?.content, "alias root rule\n");
    assert.equal(turn.snapshot.context.packageJson?.name, "alias-root");
    assert.equal(turn.snapshot.context.tsconfig?.compilerOptions.strict, true);
    assert.equal(turn.snapshot.context.readme, "alias root readme\n");
    assert.equal(turn.snapshot.context.srcTree.includes("[f] src/index.ts"), true);
    assert.equal(turn.repoMapCandidates.some((entry) => entry.symbols.includes("AliasRootSymbol")), true);
  });
}

async function testBudgetAndCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memory = new ContextMemory(() => provider.model, workspace, undefined, 120, 32 * 1024);
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(40) },
      { role: "assistant", content: "old response ".repeat(40) }
    ]);
    const messages = await memory.prepareTurn("current task ".repeat(20), "system rule ".repeat(30));
    assert.equal(estimateMessageTokens(messages) <= 120, true);
    assert.equal(messages.at(-1)?.role, "user");
    assert.equal(messages.at(-1)?.content.includes("current task"), true);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: [{ type: "reasoning", text: "reason ".repeat(20) }] }]) > 4, true);

    memory.replaceHistory(Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `message ${String(index)} ${"detail ".repeat(180)}`
    })));
    await memory.prepareTurn("continue", "system");
    const compactedStatus = await memory.status();
    assert.equal(compactedStatus.compaction.summaryPresent, true);
    assert.equal(compactedStatus.budget.autoCompacted, true);

    memory.replaceHistory([{ role: "user", content: "manual compact request" }]);
    const manual = await memory.compact("retain next steps");
    assert.equal(manual.compacted, true);
  });
}

async function testContextPreparationAbortStopsAutoCompaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const provider = new ContextTestModel();
    const model = {
      ...provider.model,
      doGenerate: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        started.resolve(undefined);
        return await new Promise<never>((_resolve, reject) => {
          const stop = (): void => {
            aborted.resolve(undefined);
            reject(abortSignal?.reason ?? new Error("aborted"));
          };
          if (abortSignal?.aborted) stop();
          else abortSignal?.addEventListener("abort", stop, { once: true });
        });
      }
    } as unknown as LanguageModel;
    const memory = new ContextMemory(
      () => model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024
    );
    memory.replaceHistory([
      { role: "user", content: "old request ".repeat(80) },
      { role: "assistant", content: "old response ".repeat(80) }
    ]);

    const controller = new AbortController();
    const pending = memory.prepareTurn("continue", "system", controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await aborted.promise;
    const status = await memory.status();
    assert.equal(status.compaction.summaryPresent, false);
    assert.equal(status.compaction.compactedMessages, 0);
  });
}

async function testRestoreWithoutPersistedBudgetUsesHistoryEstimate(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const provider = new ContextTestModel();
    const memory = new ContextMemory(
      () => provider.model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      120,
      32 * 1024
    );
    memory.restore([
      { role: "user", content: "historical request ".repeat(4) },
      { role: "assistant", content: "historical answer ".repeat(4) }
    ]);
    const status = await memory.status();
    assert.equal(status.budget.usedTokens > 0, true);
    assert.equal(status.budget.maxTokens, 120);
  });
}

async function testSessionReplayAndAgentResume(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const events: SessionEvent[] = [
      {
        type: "user_message",
        content: "inspect src/index.ts",
        contextUsage: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false }
      },
      { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "call-7", sequence: 7, assistantContent: "I will inspect the entry.", reasoningContent: "The entry file is the first target." },
      { type: "tool_result", tool: "read_file", result: { path: "src/index.ts", content: "export {}" }, toolCallId: "call-7", sequence: 7 },
      { type: "tool_call", tool: "read_file", args: { path: "src/worker.ts" }, toolCallId: "call-8", sequence: 8, assistantContent: "I will inspect the worker.", reasoningContent: "The worker is the second target." },
      { type: "tool_result", tool: "read_file", result: { path: "src/worker.ts", content: "export class Worker {}" }, toolCallId: "call-8", sequence: 8 },
      {
        type: "assistant_message",
        content: "The files define the entry and worker.",
        reasoningContent: "Both requested files were inspected.",
        usage: {
          operation: "agent",
          modelAlias: "deepseek-v4-flash",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          inputTokens: 1_234,
          outputTokens: 40,
          totalTokens: 1_274,
          pricingKnown: false
        },
        contextState: {
          summary: "Persisted handoff summary.",
          compactedMessages: 4,
          memoryTopics: ["context"],
          budget: { maxTokens: 24_000, usedTokens: 1_234, omitted: [], autoCompacted: false, source: "provider" }
        }
      }
    ];
    const filePath = sessionFilePath(workspaceRoot, "saved-session");
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const replay = await replaySession(filePath);
    assert.equal(replay.messages[1]?.role, "assistant");
    assert.equal(hasToolCall(replay.messages[1], "call-7"), true);
    assert.equal(messageReasoning(replay.messages[1]!), "The entry file is the first target.");
    assert.equal(hasToolResult(replay.messages[2], "call-7"), true);
    assert.equal(hasToolCall(replay.messages[3], "call-8"), true);
    assert.equal(messageReasoning(replay.messages[3]!), "The worker is the second target.");
    assert.equal(messageReasoning(replay.messages[5]!), "Both requested files were inspected.");
    assert.equal(sessionEventsToConversation(events).length, 6);
    assert.equal(replay.contextState?.summary, "Persisted handoff summary.");
    assert.equal(replay.usage[0]?.inputTokens, 1_234);

    const config = testConfig();
    config.context.memory.enabled = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.initialize();
    assert.equal(agent.getInfo().modelLabel, "deepseek-v4-flash");
    assert.equal(agent.getInfo().reasoningLabel, "High");
    const resumed = await agent.resume("saved-session");
    assert.equal(resumed.sessionId, "saved-session");
    assert.equal(agent.getInfo().sessionId, "saved-session");
    const restoredContext = await agent.contextStatus();
    assert.equal(restoredContext.activePaths.includes("src/index.ts"), true);
    assert.equal(restoredContext.budget.usedTokens, 1_234);
    assert.equal(restoredContext.compaction.summaryPresent, true);
    await agent.runTask("continue the review");
    assert.equal(provider.requests.at(-1)?.some((message) => hasToolCall(message, "call-7")), true);
    assert.equal(provider.requests.at(-1)?.some((message) => messageReasoning(message) === "The worker is the second target."), true);
    const pendingPlan = agent.createPlan("plan the next review");
    await assert.rejects(agent.compactConversation(), /while plan creation is running/);
    await pendingPlan;
    const savedBeforeSwitch = await fs.readFile(filePath, "utf8");
    const secondFile = sessionFilePath(workspaceRoot, "second-session");
    await fs.writeFile(secondFile, `${JSON.stringify({ type: "user_message", content: "second session" })}\n`, "utf8");
    await agent.resume("second-session");
    assert.equal(await fs.readFile(filePath, "utf8"), savedBeforeSwitch);
    await agent.close();
  });
}

async function testTruncatedSessionTailAndDanglingToolRecovery(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    assert.throws(
      () => parseSessionEvents(JSON.stringify({ type: "user_message", content: 42 })),
      /Invalid session event at line 1.*content/u
    );
    const filePath = sessionFilePath(workspaceRoot, "interrupted-session");
    const events: SessionEvent[] = [
      { type: "user_message", content: "inspect the project" },
      { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "dangling-1", sequence: 1 }
    ];
    await fs.writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n{"type":"assistant`, "utf8");

    const readable = await readSessionEvents(filePath);
    assert.equal(readable.length, 2);
    const replay = await replaySession(filePath);
    assert.equal(replay.recoveredToolResults.length, 1);
    assert.equal(replay.recoveredToolResults[0]?.toolCallId, "dangling-1");
    assert.equal(replay.messages.some((message) => message.role === "tool"), true);

    await repairSessionTailForAppend(filePath);
    const recorder = new SessionRecorder(workspaceRoot, "interrupted-session");
    for (const event of replay.recoveredToolResults) recorder.record(event);
    await recorder.close();
    const repaired = await readSessionEvents(filePath);
    assert.equal(repaired.length, 3);
    assert.equal((await replaySession(filePath)).recoveredToolResults.length, 0);

    const supersededFile = sessionFilePath(workspaceRoot, "superseded-tool-call");
    await fs.writeFile(supersededFile, [
      JSON.stringify({ type: "user_message", content: "first turn" }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "old.ts" }, toolCallId: "old-call", sequence: 1 }),
      JSON.stringify({ type: "assistant_message", content: "continued without that result" }),
      JSON.stringify({ type: "user_message", content: "later turn" })
    ].join("\n") + "\n", "utf8");
    const supersededReplay = await replaySession(supersededFile);
    assert.equal(supersededReplay.recoveredToolResults.length, 0);
    assert.equal(supersededReplay.messages.some((message) => hasToolResult(message, "old-call")), false);

    const healthyListFile = sessionFilePath(workspaceRoot, "healthy-list-session");
    const corruptListFile = sessionFilePath(workspaceRoot, "corrupt-list-session");
    await fs.writeFile(healthyListFile, `${JSON.stringify({ type: "user_message", content: "healthy list entry" })}\n`, "utf8");
    await fs.writeFile(corruptListFile, "{not-json}\n", "utf8");
    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyListFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(corruptListFile)), false);
  });
}

async function testSessionAndToolDisplayRedaction(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const toolCallId = "sk-test-tool-call-12345678";
    const userSecret = "not-a-real-user-bearer-value";
    const argumentSecret = "opaque-argument-value";
    const resultSecret = "opaque-result-value";
    const recorder = new SessionRecorder(workspaceRoot, "redacted-session");
    recorder.record({ type: "user_message", content: `Authorization: Bearer ${userSecret}` });
    recorder.record({
      type: "tool_call",
      tool: "external_probe",
      args: {
        apiKey: argumentSecret,
        webhookSecret: argumentSecret,
        nested: { authorization: `Bearer ${argumentSecret}` },
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    recorder.record({
      type: "tool_result",
      tool: "external_probe",
      result: {
        stdout: `token=${resultSecret}`,
        diffPreview: `+ refresh_token=${resultSecret}`,
        safe: "visible"
      },
      toolCallId,
      sequence: 1
    });
    await recorder.close();

    const raw = await fs.readFile(recorder.filePath, "utf8");
    for (const secret of [userSecret, argumentSecret, resultSecret]) assert.equal(raw.includes(secret), false);
    assert.match(raw, /\[redacted\]/);
    const events = parseSessionEvents(raw);
    const call = events.find((event): event is Extract<SessionEvent, { type: "tool_call" }> => event.type === "tool_call");
    const result = events.find((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result");
    assert.equal(call?.toolCallId, toolCallId);
    assert.equal((call?.args as { apiKey?: string } | undefined)?.apiKey, "[redacted]");
    assert.equal((call?.args as { webhookSecret?: string } | undefined)?.webhookSecret, "[redacted]");
    assert.equal((result?.result as { safe?: string } | undefined)?.safe, "visible");

    const genericSecret = "opaque-generic-value";
    const generic = await createToolPermissionRequest({
      id: "generic-secret",
      name: "mcp_demo_probe",
      args: { apiKey: genericSecret, nested: { password: genericSecret }, safe: "visible" }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(generic).includes(genericSecret), false);
    assert.match(generic.details, /\[redacted\]/);

    const commandSecret = "not-a-real-command-bearer-value";
    const command = await createToolPermissionRequest({
      id: "command-secret",
      name: "run_command",
      args: { command: `curl -H 'Authorization: Bearer ${commandSecret}' https://example.invalid` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(command).includes(commandSecret), false);

    const previewSecret = "not-a-real-preview-value";
    const write = await createToolPermissionRequest({
      id: "preview-secret",
      name: "write_file",
      args: { path: "safe-preview.txt", content: `apiKey=${previewSecret}\n` }
    }, { workspaceRoot, ignore: [], sessionId: "test" });
    assert.equal(JSON.stringify(write).includes(previewSecret), false);
    assert.match(write.preview ?? "", /\[redacted\]/);
  });
}

async function testSessionPathBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const safeFile = sessionFilePath(workspaceRoot, "2026-07-18-safe");
    await fs.writeFile(safeFile, `${JSON.stringify({ type: "user_message", content: "safe session" })}\n`, "utf8");
    const canonicalSafeFile = await fs.realpath(safeFile);

    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "2026-07-18-safe.jsonl"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, ".agent/sessions/2026-07-18-safe.jsonl"), canonicalSafeFile);
    assert.equal(await resolveSessionFile(workspaceRoot, "latest"), canonicalSafeFile);
    assert.match((await readSessionSnapshot(workspaceRoot, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);
    assert.equal((await readStoredSessionEvents(workspaceRoot, "2026-07-18-safe")).events[0]?.type, "user_message");
    const duplicatePath = await duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "safe-copy");
    assert.equal(await fs.readFile(duplicatePath, "utf8"), await fs.readFile(safeFile, "utf8"));
    await deleteSessionFile(workspaceRoot, "safe-copy");
    await assert.rejects(fs.access(duplicatePath));
    const deleteTombstones = (await fs.readdir(path.dirname(duplicatePath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(deleteTombstones.length, 1);
    assert.equal((await fs.stat(path.join(path.dirname(duplicatePath), deleteTombstones[0] ?? "missing"))).size, 0);
    assert.equal((await listSessionFiles(workspaceRoot)).some((fileName) => fileName.endsWith(".delete")), false);

    assert.throws(() => sessionFilePath(workspaceRoot, "../outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested/outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "nested\\outside"), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, "."), /Invalid session id/);
    assert.throws(() => sessionFilePath(workspaceRoot, ".."), /Invalid session id/);
    await assert.rejects(resolveSessionFile(workspaceRoot, safeFile), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, "../outside.jsonl"), /Invalid session reference/);
    await assert.rejects(resolveSessionFile(workspaceRoot, ".agent/sessions/../outside.jsonl"), /Invalid session reference/);

    const sessionsDir = path.join(workspaceRoot, ".agent", "sessions");
    await fs.mkdir(path.join(sessionsDir, "directory.jsonl"));
    await assert.rejects(resolveSessionFile(workspaceRoot, ".agent/sessions/directory.jsonl"), /regular \.jsonl file/);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-session-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "outside.jsonl");
      const outsideContent = '{"type":"user_message"';
      await fs.writeFile(outsideFile, outsideContent, "utf8");
      await fs.symlink(outsideFile, path.join(sessionsDir, "linked.jsonl"));
      await assert.rejects(resolveSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "linked"), /regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "linked", "linked-copy"), /regular \.jsonl file/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "linked"), /regular \.jsonl file/);

      const hardlinkedFile = path.join(sessionsDir, "hardlinked.jsonl");
      await fs.link(outsideFile, hardlinkedFile);
      await assert.rejects(resolveSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "2026-07-18-safe", "hardlinked"), /EEXIST/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      await assert.rejects(repairSessionTailForAppend(hardlinkedFile), /single-link regular \.jsonl file/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "hardlinked"), /single-link regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);

      const workspaceAlias = path.join(outsideRoot, "workspace-alias");
      await fs.symlink(workspaceRoot, workspaceAlias);
      assert.match((await readSessionSnapshot(workspaceAlias, "2026-07-18-safe")).bytes.toString("utf8"), /safe session/);

      const pinnedRecorder = new SessionRecorder(workspaceRoot, "pinned-before-parent-swap");
      const originalSessionsDir = path.join(workspaceRoot, ".agent", "sessions-original");
      await fs.rename(sessionsDir, originalSessionsDir);
      await fs.symlink(outsideRoot, sessionsDir);
      assert.throws(
        () => pinnedRecorder.record({ type: "user_message", content: "must not escape" }),
        /changed while it was being opened|ENOENT/
      );
      await pinnedRecorder.close();
      await assert.rejects(fs.access(path.join(outsideRoot, "pinned-before-parent-swap.jsonl")));
      await fs.rm(sessionsDir, { force: true });
      await fs.rename(originalSessionsDir, sessionsDir);

      const config = testConfig();
      config.context.memory.enabled = false;
      const provider = new ContextTestModel();
      const agent = new AgentSession({
        workspaceRoot,
        config,
        model: provider.model,
        toolRegistry: new ToolRegistry(),
        permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
        recorder: new SessionRecorder(workspaceRoot)
      });
      await agent.initialize();
      await assert.rejects(agent.resume(".agent/sessions/linked.jsonl"), /regular \.jsonl file/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
      await agent.close();

      await fs.rm(sessionsDir, { recursive: true, force: true });
      await fs.symlink(outsideRoot, sessionsDir);
      await assert.rejects(resolveSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(readSessionSnapshot(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(duplicateSessionFile(workspaceRoot, "outside", "must-not-copy"), /real directory, not a symbolic link/);
      await assert.rejects(deleteSessionFile(workspaceRoot, "outside"), /real directory, not a symbolic link/);
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      assert.throws(() => new SessionRecorder(workspaceRoot, "must-not-escape"), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "must-not-escape.jsonl")));

      await fs.rm(sessionsDir, { force: true });
      await fs.rm(path.join(workspaceRoot, ".agent"), { recursive: true, force: true });
      await fs.symlink(outsideRoot, path.join(workspaceRoot, ".agent"));
      await assert.rejects(ensureAgentDirs(workspaceRoot), /real directory, not a symbolic link/);
      await assert.rejects(fs.access(path.join(outsideRoot, "sessions")));
      assert.equal(await fs.readFile(outsideFile, "utf8"), outsideContent);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testSessionReadLimits(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const healthyFile = sessionFilePath(workspaceRoot, "bounded-healthy");
    await fs.writeFile(healthyFile, `${JSON.stringify({ type: "user_message", content: "healthy bounded session" })}\n`, "utf8");
    const oversizedFile = sessionFilePath(workspaceRoot, "oversized-session");
    await fs.writeFile(oversizedFile, "", "utf8");
    await fs.truncate(oversizedFile, maxSessionFileBytes + 1);

    await assert.rejects(readSessionEvents(oversizedFile), /maximum size/u);
    await assert.rejects(readStoredSessionEvents(workspaceRoot, "oversized-session"), /maximum size/u);
    await assert.rejects(readSessionSnapshot(workspaceRoot, "oversized-session"), /maximum size/u);
    await assert.rejects(repairSessionTailForAppend(oversizedFile), /maximum size/u);
    const oversizedRecorder = new SessionRecorder(workspaceRoot, "oversized-session");
    assert.throws(() => oversizedRecorder.readText(), /maximum size/u);
    await oversizedRecorder.close();

    const summaries = await listSessionSummaries(workspaceRoot);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(healthyFile)), true);
    assert.equal(summaries.some((summary) => summary.fileName === path.basename(oversizedFile)), false);

    const oversizedLine = JSON.stringify({ type: "user_message", content: "x".repeat(maxSessionEventLineBytes) });
    assert.throws(() => parseSessionEvents(`${oversizedLine}\n`), /event line 1 exceeds the maximum size/u);
    const eventLine = JSON.stringify({ type: "user_message", content: "bounded event" });
    const tooManyEvents = `${Array.from({ length: maxSessionEvents + 1 }, () => eventLine).join("\n")}\n`;
    assert.throws(() => parseSessionEvents(tooManyEvents), /cannot contain more than/u);
  });
}

async function testDeleteSessionReplacementRace(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const targetPath = sessionFilePath(workspaceRoot, "delete-race");
    const pinnedBackupPath = path.join(path.dirname(targetPath), "delete-race.pinned-backup");
    const originalContent = `${JSON.stringify({ type: "user_message", content: "original target" })}\n`;
    const replacementContent = `${JSON.stringify({ type: "user_message", content: "replacement must survive" })}\n`;
    await fs.writeFile(targetPath, originalContent, "utf8");

    let injected = false;
    await assert.rejects(deleteSessionFile(workspaceRoot, "delete-race", {
      beforeTombstoneMove: async ({ filePath }) => {
        injected = true;
        await fs.rename(filePath, pinnedBackupPath);
        await fs.writeFile(targetPath, replacementContent, "utf8");
      }
    }), /changed during deletion/u);

    assert.equal(injected, true);
    assert.equal(await fs.readFile(pinnedBackupPath, "utf8"), originalContent);
    assert.equal(await fs.readFile(targetPath, "utf8"), replacementContent);
    const tombstones = (await fs.readdir(path.dirname(targetPath)))
      .filter((fileName) => fileName.startsWith(".session-delete-") && fileName.endsWith(".delete"));
    assert.equal(tombstones.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(targetPath), tombstones[0] ?? "missing"), "utf8"), replacementContent);

    const lateTargetPath = sessionFilePath(workspaceRoot, "delete-late-race");
    const pinnedAfterVerificationPath = path.join(path.dirname(lateTargetPath), "delete-late-race.pinned-after-verification");
    const lateOriginalContent = `${JSON.stringify({ type: "user_message", content: "late original" })}\n`;
    const lateReplacementContent = `${JSON.stringify({ type: "user_message", content: "late replacement must survive" })}\n`;
    await fs.writeFile(lateTargetPath, lateOriginalContent, "utf8");
    let replacedTombstonePath = "";
    await deleteSessionFile(workspaceRoot, "delete-late-race", {
      afterTombstoneVerified: async ({ tombstonePath }) => {
        replacedTombstonePath = tombstonePath;
        await fs.rename(tombstonePath, pinnedAfterVerificationPath);
        await fs.writeFile(tombstonePath, lateReplacementContent, "utf8");
      }
    });
    await assert.rejects(fs.access(lateTargetPath));
    assert.equal((await fs.stat(pinnedAfterVerificationPath)).size, 0);
    assert.equal(await fs.readFile(replacedTombstonePath, "utf8"), lateReplacementContent);
  });
}

async function testFailedCurrentSessionResumeKeepsRecorderUsable(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const brokenSessionId = "broken-current";
    const brokenFile = sessionFilePath(workspaceRoot, brokenSessionId);
    await fs.writeFile(brokenFile, [
      JSON.stringify({ type: "user_message", content: "valid prefix" }),
      "{not-json}",
      JSON.stringify({ type: "assistant_message", content: "valid suffix" })
    ].join("\n") + "\n", "utf8");
    const config = testConfig();
    config.context.memory.enabled = false;
    const provider = new ContextTestModel();
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder: new SessionRecorder(workspaceRoot, brokenSessionId)
    });
    await agent.initialize();

    await assert.rejects(agent.resume(brokenSessionId), /Invalid JSONL event at line 2/);
    const fallbackSession = agent.getInfo();
    assert.notEqual(fallbackSession.sessionId, brokenSessionId);
    assert.equal((await agent.runTask("continue in a healthy session")).output, "ok");
    await agent.close();
    const fallbackEvents = await readSessionEvents(fallbackSession.sessionFile);
    assert.deepEqual(fallbackEvents.map((event) => event.type), ["user_message", "assistant_message"]);
  });
}

async function testCredentialAndSymlinkBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "agent.config.json"), JSON.stringify({ providers: { demo: { apiKey: "test-secret-value" } } }), "utf8");
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "agent.config.json", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".env.local", []), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".envrc", []), /ignored by workspace policy/);
    assert.equal(redactSecrets('{"apiKey":"test-secret-value"}'), '{"apiKey":"[redacted]"}');
    await fs.symlink(path.join(workspaceRoot, "agent.config.json"), path.join(workspaceRoot, "config-link.json"));
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "config-link.json", []), /resolves to a location ignored/);
    const criticalWrite = await createToolPermissionRequest({
      id: "critical-write",
      name: "write_file",
      args: { path: ".zshrc", content: "export SAFE_TEST=1\n" }
    }, { workspaceRoot, ignore: [], sessionId: "test-session" });
    assert.equal(criticalWrite.riskLevel, "critical");
    assert.equal(criticalWrite.requireFullYes, true);

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-outside-"));
    try {
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
      await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(workspaceRoot, "linked-secret.txt"));
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked-directory"));
      await fs.symlink(path.join(outsideRoot, "future.txt"), path.join(workspaceRoot, "dangling-secret.txt"));
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-secret.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "linked-directory/new.txt", []), /symbolic link/);
      assert.throws(() => resolveWorkspacePath(workspaceRoot, "dangling-secret.txt", []), /dangling symbolic link/);

      await ensureAgentDirs(workspaceRoot);
      const telemetryPath = path.join(workspaceRoot, ".agent", "telemetry.jsonl");
      const telemetryVictim = path.join(outsideRoot, "telemetry-victim.txt");
      await fs.writeFile(telemetryVictim, "telemetry-victim-unchanged", "utf8");
      await fs.symlink(telemetryVictim, telemetryPath);
      await createLocalTelemetry(telemetryPath).onError?.(new Error("not written"));
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");
      await fs.rm(telemetryPath);
      await fs.link(telemetryVictim, telemetryPath);
      await createLocalTelemetry(telemetryPath).onError?.(new Error("not written"));
      assert.equal(await fs.readFile(telemetryVictim, "utf8"), "telemetry-victim-unchanged");

      const historyPath = path.join(workspaceRoot, ".agent", "input-history.jsonl");
      const historyVictim = path.join(outsideRoot, "history-victim.txt");
      await fs.writeFile(historyVictim, "history-victim-unchanged", "utf8");
      await fs.symlink(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      await assert.rejects(loadInputHistory(workspaceRoot), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      await fs.link(historyVictim, historyPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape"), /single-link regular file/);
      assert.equal(await fs.readFile(historyVictim, "utf8"), "history-victim-unchanged");
      await fs.rm(historyPath);
      const agentPath = path.join(workspaceRoot, ".agent");
      const originalAgentPath = path.join(workspaceRoot, ".agent-original");
      await fs.rename(agentPath, originalAgentPath);
      await fs.symlink(outsideRoot, agentPath);
      await assert.rejects(appendInputHistory(workspaceRoot, "must not escape through parent"), /real directory/);
      await assert.rejects(loadInputHistory(workspaceRoot), /real canonical directory/);
      await assert.rejects(fs.access(path.join(outsideRoot, "input-history.jsonl")));
      await fs.rm(agentPath);
      await fs.rename(originalAgentPath, agentPath);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testMemoryRedactionDedupAndWriter(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const storeProvider = new ContextTestModel();
    const store = new LocalMemory(workspaceRoot, () => storeProvider.model);
    const first = await store.write({
      topic: "debugging",
      title: "Context refresh result",
      summary: "Refresh src/agent/context/ContextMemory.ts after write_file. apiKey=sk-supersecretvalue123.",
      decisions: ["Use deterministic Markdown memory."],
      paths: ["src/agent/context/ContextMemory.ts"],
      keywords: ["context", "refresh"]
    });
    assert.equal(first.written, true);
    const duplicate = await store.write({
      topic: "debugging",
      title: "Context refresh result",
      summary: "Refresh src/agent/context/ContextMemory.ts after write_file. apiKey=sk-supersecretvalue123.",
      decisions: ["Use deterministic Markdown memory."],
      paths: ["src/agent/context/ContextMemory.ts"],
      keywords: ["context", "refresh"]
    });
    assert.equal(duplicate.written, false);

    const debugFile = path.join(workspaceRoot, ".agent", "memory", "debugging.md");
    const stored = await fs.readFile(debugFile, "utf8");
    assert.equal(stored.includes("sk-supersecretvalue123"), false);
    assert.match(stored, /\[redacted\]/);
    assert.match(redactSecrets("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
    assert.equal(redactSecrets("aws_secret_access_key=not-a-real-value"), "aws_secret_access_key=[redacted]");
    assert.equal(redactSecrets("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"), "[redacted private key]");
    assert.equal((await store.findRelevant("context refresh", ["src/agent/context/ContextMemory.ts"])).length > 0, true);
    const abortedLookup = new AbortController();
    abortedLookup.abort();
    await assert.rejects(store.findRelevant("context refresh", [], 3, abortedLookup.signal), /abort/i);

    await store.rememberSuccessfulTask(
      "Implement a deterministic context refresh workflow for tool writes. ".repeat(4),
      "The runtime now refreshes the snapshot and RepoMap after write_file before the next turn. ".repeat(4)
    );
    assert.equal((await store.listTopics()).includes("workflows"), true);
  });
}

async function testMemoryQueueLifecycleAndUsagePersistence(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let active = 0;
    let peak = 0;
    let started = 0;
    const queuedMemory = {
      rememberSuccessfulTask: async (): Promise<void> => {
        const index = started;
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await (index === 0 ? firstGate.promise : secondGate.promise);
        active -= 1;
      }
    } as unknown as LocalMemory;
    const memory = new ContextMemory(
      () => new ContextTestModel().model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      queuedMemory,
      24_000,
      32 * 1024
    );
    memory.queueSuccessfulTask("first", "answer");
    memory.queueSuccessfulTask("second", "answer");
    await waitUntil(() => started === 1);
    assert.equal(peak, 1);
    firstGate.resolve(undefined);
    await waitUntil(() => started === 2);
    assert.equal(peak, 1);
    secondGate.resolve(undefined);
    await memory.flush();

    let stuckStarted = false;
    const stuckMemory = {
      rememberSuccessfulTask: async (): Promise<void> => {
        stuckStarted = true;
        await new Promise<void>(() => undefined);
      }
    } as unknown as LocalMemory;
    const bounded = new ContextMemory(
      () => new ContextTestModel().model,
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      stuckMemory,
      24_000,
      32 * 1024
    );
    bounded.queueSuccessfulTask("stuck", "answer");
    await waitUntil(() => stuckStarted);
    const shutdownStartedAt = Date.now();
    await bounded.shutdownMemory(20);
    assert.ok(Date.now() - shutdownStartedAt < 800);

    const config = testConfig();
    config.context.memory.enabled = true;
    const provider = new ContextTestModel();
    await ensureAgentDirs(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "memory-usage");
    const agent = new AgentSession({
      workspaceRoot,
      config,
      model: provider.model,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
      recorder
    });
    await agent.initialize();
    await agent.runTask(`Remember this successful context workflow: ${"grounded details ".repeat(20)}`);
    await agent.close();
    const replay = await replaySession(recorder.filePath);
    assert.equal(replay.usage.some((usage) => usage.operation === "memory"), true);
  });
}

async function testMemoryStorageBoundaries(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await ensureAgentDirs(workspaceRoot);
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-outside-"));
    const store = new LocalMemory(workspaceRoot, () => new ContextTestModel().model);
    const entry = {
      topic: "debugging",
      title: "Safe local memory boundary",
      summary: "This sufficiently long test summary must never be written through an unsafe memory link.",
      decisions: [],
      paths: [],
      keywords: ["boundary"]
    };
    try {
      const victim = path.join(outsideRoot, "victim.md");
      const victimContent = "outside-memory-must-stay-unchanged";
      await fs.writeFile(victim, victimContent, "utf8");
      const memoryDir = path.join(workspaceRoot, ".agent", "memory");

      await fs.symlink(outsideRoot, memoryDir);
      await assert.rejects(store.findRelevant("outside-memory", []), /real directory, not a symbolic link/);
      await assert.rejects(store.write(entry), /real directory, not a symbolic link/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);

      await fs.rm(memoryDir, { force: true });
      await fs.mkdir(memoryDir);
      await fs.symlink(victim, path.join(memoryDir, "MEMORY.md"));
      await assert.rejects(store.findRelevant("outside-memory", []), /single regular file/);
      await assert.rejects(store.write(entry), /single regular file/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);

      await fs.rm(path.join(memoryDir, "MEMORY.md"), { force: true });
      await fs.link(victim, path.join(memoryDir, "debugging.md"));
      await assert.rejects(store.listTopics(), /single regular file/);
      await assert.rejects(store.write(entry), /single regular file/);
      assert.equal(await fs.readFile(victim, "utf8"), victimContent);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
}

async function testToolWriteMarksSnapshotAndRepoMapDirty(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "context-test" }), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "existing.ts"), "export const existing = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    const memoryProvider = new ContextTestModel();
    const memory = new ContextMemory(() => memoryProvider.model, workspace, undefined, 24_000, 32 * 1024);
    await memory.initialize();
    assert.equal((await memory.status()).snapshotDirty, false);

    await fs.writeFile(path.join(workspaceRoot, "src", "new.ts"), "export const created = true;\n", "utf8");
    memory.observeToolResult("write_file", { path: "src/new.ts" }, { path: "src/new.ts", bytes: 28 });
    const dirty = await memory.status();
    assert.equal(dirty.snapshotDirty, true);
    assert.equal(dirty.repoMapDirty, true);
    assert.equal(dirty.activePaths.includes("src/new.ts"), true);

    const messages = await memory.prepareTurn("review src/new.ts", "system");
    assert.equal(messages.at(-1)?.content, "review src/new.ts");
    const refreshed = await memory.status();
    assert.equal(refreshed.snapshotDirty, false);
    assert.equal(refreshed.repoMapDirty, false);
  });
}

function hasToolCall(message: ModelMessage | undefined, toolCallId: string): boolean {
  return Boolean(message?.role === "assistant" && Array.isArray(message.content) && message.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId));
}

function hasToolResult(message: ModelMessage | undefined, toolCallId: string): boolean {
  return Boolean(message?.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId));
}

function testConfig(): AgentConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as AgentConfig;
}

async function withTempWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-context-"));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for context test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

await main();
