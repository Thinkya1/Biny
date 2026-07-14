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
import type { AgentConfig } from "../src/config/schema.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession, sessionEventsToConversation } from "../src/session/replay.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

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
  await testInstructionHierarchyAndCap();
  await testInstructionLoadingWaitsForToolAccess();
  await testRepoMapExactCandidate();
  await testBudgetAndCompaction();
  await testRestoreWithoutPersistedBudgetUsesHistoryEstimate();
  await testSessionReplayAndAgentResume();
  await testMemoryRedactionDedupAndWriter();
  await testToolWriteMarksSnapshotAndRepoMapDirty();
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

async function testInstructionLoadingWaitsForToolAccess(): Promise<void> {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src", "feature"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "root rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "AGENTS.md"), "feature rule\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature", "entry.ts"), "export const entry = true;\n", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024);
    await workspace.prepareTurn("inspect src/feature/entry.ts");
    assert.deepEqual(workspace.status().loadedInstructions, ["AGENTS.md"]);

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
    await agent.close();
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
    assert.equal((await store.findRelevant("context refresh", ["src/agent/context/ContextMemory.ts"])).length > 0, true);

    await store.rememberSuccessfulTask(
      "Implement a deterministic context refresh workflow for tool writes. ".repeat(4),
      "The runtime now refreshes the snapshot and RepoMap after write_file before the next turn. ".repeat(4)
    );
    assert.equal((await store.listTopics()).includes("workflows"), true);
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

await main();
