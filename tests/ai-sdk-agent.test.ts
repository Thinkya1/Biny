import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createLanguageModelForConfig } from "../src/llm/factory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

async function main(): Promise<void> {
  await testAgentStreamsFinalAnswer();
  await testAgentRunsToolAndKeepsSessionEvents();
  await testPlanModeExposesOnlyReadTools();
  await testInvalidToolInputUsesCoordinatorValidation();
  await testParallelPermissionGate();
  await testModelFailureIsNotRetried();
  await testPreAbortedRunStopsBeforeRequest();
}

async function testAgentStreamsFinalAnswer(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const { agent, cleanup, sessionFile, workspaceRoot } = await createAgent();
  try {
    const events = await collect(runAgent(agent, "hi"));
    assert.equal(calls, 1);
    assert.equal(events.some((event) => event.type === "sdk" && event.part.type === "text-delta"), true);
    assert.equal(events.some((event) => event.type === "done" && event.content === "hello"), true);
    await agent.close();
    const sessionEvents = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; usage?: { inputTokens?: number }; contextState?: { budget?: { source?: string } } });
    const assistant = sessionEvents.find((event) => event.type === "assistant_message");
    assert.equal(assistant?.usage?.inputTokens, 12);
    assert.equal(assistant?.contextState?.budget?.source, "provider");
    const telemetry = await readFile(path.join(workspaceRoot, ".agent", "telemetry.jsonl"), "utf8");
    assert.match(telemetry, /"type":"end"/);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testAgentRunsToolAndKeepsSessionEvents(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requests.length === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "README read" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const registry = new ToolRegistry();
  registry.register(readFileTool());
  const { agent, cleanup, sessionFile } = await createAgent(registry);
  try {
    const events = await collect(runAgent(agent, "Read README.md"));
    assert.equal(requests.length, 2);
    assert.equal(events.some((event) => event.type === "tool-started" && event.toolCallId === "read-1"), true);
    assert.equal(events.some((event) => event.type === "sdk" && event.part.type === "tool-result"), true);
    assert.equal(events.some((event) => event.type === "done" && event.content === "README read"), true);
    await agent.close();
    const sessionEvents = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; contextUsage?: { usedTokens?: number } });
    assert.deepEqual(sessionEvents.map((event) => event.type), ["user_message", "tool_call", "tool_result", "assistant_message"]);
    assert.equal(typeof sessionEvents[0]?.contextUsage?.usedTokens, "number");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testInvalidToolInputUsesCoordinatorValidation(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requests.length === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "bad-1", type: "function", function: { name: "read_file", arguments: "{\"path\":123}" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "invalid handled" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const registry = new ToolRegistry();
  registry.register(readFileTool());
  const { agent, cleanup } = await createAgent(registry);
  try {
    const events = await collect(runAgent(agent, "Read README.md"));
    assert.equal(requests.length, 2);
    assert.equal(events.some((event) => event.type === "error" && /invalid tool arguments/i.test(event.message)), true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testPlanModeExposesOnlyReadTools(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "plan answer" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const registry = new ToolRegistry();
  registry.register({ ...readFileTool(), risk: "read" });
  registry.register({
    name: "write_file",
    description: "Write a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    schema: z.object({ path: z.string(), content: z.string() }),
    risk: "write",
    resolveExecution() {
      return { approvalRule: "write_file", async execute() { return { written: true }; } };
    }
  } as Tool);

  const { agent, cleanup } = await createAgent(registry);
  try {
    const events = await collect(agent.run("Research this task", { mode: "plan" }));
    assert.equal(requests.length, 1);
    assert.deepEqual(requestToolNames(requests[0]), ["read_file"]);
    assert.equal(events.some((event) => event.type === "done" && event.content === "plan answer"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testParallelPermissionGate(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "write-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"one.txt\",\"content\":\"one\"}" } },
          { index: 1, id: "write-2", type: "function", function: { name: "write_file", arguments: "{\"path\":\"two.txt\",\"content\":\"two\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "writes complete" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "Write a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    schema: z.object({ path: z.string(), content: z.string() }),
    resolveExecution(args: { path: string; content: string }) {
      return { approvalRule: "write_file", async execute() { return { path: args.path }; } };
    }
  } as Tool);

  let confirmCount = 0;
  const { agent, cleanup } = await createAgent(registry);
  try {
    const events = await collect(runAgent(agent, "write two files", async () => {
      confirmCount += 1;
      return { approved: true, scope: "tool" };
    }));
    assert.equal(requestCount, 2);
    assert.equal(confirmCount, 1);
    assert.equal(events.filter((event) => event.type === "sdk" && event.part.type === "tool-result").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testModelFailureIsNotRetried(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const { agent, cleanup } = await createAgent();
  try {
    const events = await collect(runAgent(agent, "hi"));
    assert.equal(calls, 1);
    assert.equal(events.some((event) => event.type === "error" && /No output generated|upstream unavailable|503/i.test(event.message)), true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testPreAbortedRunStopsBeforeRequest(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return sseResponse([{ choices: [{ index: 0, delta: { content: "unexpected" }, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;

  const { agent, cleanup } = await createAgent();
  const controller = new AbortController();
  controller.abort();
  try {
    const events = await collect(runAgent(agent, "hi", undefined, controller.signal));
    assert.equal(calls, 1);
    assert.equal(events.some((event) => event.type === "error"), true);
    assert.equal(events.some((event) => event.type === "done" && event.content === ""), true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

function readFileTool(): Tool {
  return {
    name: "read_file",
    description: "Read a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    schema: z.object({ path: z.string() }),
    risk: "read",
    resolveExecution(args: { path: string }) {
      return { approvalRule: "read_file", async execute() { return { path: args.path, content: "# Biny" }; } };
    }
  } as Tool;
}

function requestToolNames(request: Record<string, unknown> | undefined): string[] {
  if (!request || !Array.isArray(request.tools)) return [];
  return request.tools.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.name === "string") return [entry.name];
    if (!isRecord(entry.function) || typeof entry.function.name !== "string") return [];
    return [entry.function.name];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createAgent(registry = new ToolRegistry()): Promise<{ agent: AgentSession; sessionFile: string; workspaceRoot: string; cleanup: (agent: AgentSession, alreadyClosed?: boolean) => Promise<void> }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sdk-runtime-"));
  await ensureAgentDirs(workspaceRoot);
  const config = configFor();
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model: createLanguageModelForConfig(config),
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  await agent.initialize();
  return {
    agent,
    sessionFile: recorder.filePath,
    workspaceRoot,
    cleanup: async (current, alreadyClosed = false) => {
      if (!alreadyClosed) await current.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function runAgent(
  agent: AgentSession,
  input: string,
  confirmPermission?: () => Promise<{ approved: boolean; scope: "once" | "tool" }>,
  abortSignal?: AbortSignal
): AsyncIterable<AgentSessionEvent> {
  return agent.run(input, {
    confirmPermission: confirmPermission ?? (async () => ({ approved: true, scope: "once" })),
    abortSignal
  });
}

function configFor(): AgentConfig {
  return configSchema.parse({
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
    models: { "test-model": { provider: "active", model: "test-model" } },
    thinking: { enabled: false, effort: "high" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: { ...defaultConfig.context, memory: { enabled: false } }
  });
}

function sseResponse(parts: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = parts.map((part) => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable: AsyncIterable<AgentSessionEvent>): Promise<AgentSessionEvent[]> {
  const events: AgentSessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

await main();
