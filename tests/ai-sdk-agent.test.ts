import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentSessionEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createLanguageModelForConfig } from "../src/llm/factory.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

async function main(): Promise<void> {
  await testAgentStreamsFinalAnswer();
  await testAgentRunsToolAndKeepsSessionEvents();
  await testPlanModeExposesOnlyReadTools();
  await testInvalidToolInputUsesCoordinatorValidation();
  await testParallelPermissionGate();
  await testCommandScopedGrantUsesExactArguments();
  await testStrongConfirmationIsEnforcedByCoordinator();
  await testDuplicateToolCallIdsStopBeforeExecution();
  await testParallelPermissionAbortSettlesAllCalls();
  await testPipelineAdmissionBoundsPermissionWaiters();
  await testAbortQuarantinesExternalResolveUntilLateSettlement();
  await testAbortQuarantinesExternalToolUntilLateSettlement();
  await testCloseDoesNotWaitForQuarantinedExternalTool();
  await testAbortDrainsCooperativeBuiltinTool();
  await testStalePermissionPreviewPreventsExecution();
  await testCanonicalPermissionPathCannotBypassDeny();
  await testModelFailureIsNotRetried();
  await testPreAbortedRunStopsBeforeRequest();
  await testPreAbortedPlanRecordsAttempt();
  await testConsumerReturnAbortsAndDrainsStream();
}

async function testCommandScopedGrantUsesExactArguments(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "deploy-staging", type: "function", function: { name: "deploy_target", arguments: "{\"environment\":\"staging\"}" } },
          { index: 1, id: "deploy-production", type: "function", function: { name: "deploy_target", arguments: "{\"environment\":\"production\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "deploy checks complete" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "deploy_target",
    description: "Deploy to a named environment.",
    parameters: { type: "object", properties: { environment: { type: "string" } }, required: ["environment"], additionalProperties: false },
    schema: z.object({ environment: z.string() }),
    risk: "execute",
    resolveExecution() {
      return {
        approvalRule: "deploy_target",
        async execute() {
          executeCount += 1;
          return { deployed: true };
        }
      };
    }
  } as Tool, "mcp");

  const approvalRules: string[] = [];
  const { agent, cleanup } = await createAgent(registry);
  try {
    await collect(runAgent(agent, "check two deploy targets", async (request) => {
      approvalRules.push(request.approvalRule ?? "");
      return { approved: true, scope: "command" };
    }));
    assert.equal(requestCount, 2);
    assert.equal(executeCount, 2);
    assert.equal(approvalRules.length, 2);
    assert.notEqual(approvalRules[0], approvalRules[1]);
    assert.doesNotMatch(approvalRules.join(" "), /staging|production/);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testStrongConfirmationIsEnforcedByCoordinator(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount % 2 === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: `critical-${String(requestCount)}`, type: "function", function: { name: "run_command", arguments: "{\"command\":\"sudo echo test-only\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "critical command handled" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let executeCount = 0;
  const toolDefinition: Tool = {
    name: "run_command",
    description: "Execute a command for the confirmation test.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    schema: z.object({ command: z.string() }),
    risk: "execute",
    resolveExecution(args: { command: string }) {
      return {
        approvalRule: `run_command(${args.command})`,
        async execute() {
          executeCount += 1;
          return { exitCode: 0 };
        }
      };
    }
  } as Tool;

  const deniedRegistry = new ToolRegistry();
  deniedRegistry.register(toolDefinition);
  const deniedAgent = await createAgent(deniedRegistry);
  try {
    await collect(runAgent(deniedAgent.agent, "run critical command", async () => ({
      approved: true,
      scope: "once",
      nextMode: "full-access"
    })));
    assert.equal(executeCount, 0);
    assert.equal(deniedAgent.permissionManager.getStatus().mode, "ask");
  } finally {
    await deniedAgent.cleanup(deniedAgent.agent);
  }

  const allowedRegistry = new ToolRegistry();
  allowedRegistry.register(toolDefinition);
  const allowedAgent = await createAgent(allowedRegistry);
  try {
    await collect(runAgent(allowedAgent.agent, "run confirmed critical command", async () => ({
      approved: true,
      scope: "once",
      confirmation: " YES "
    })));
    assert.equal(executeCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await allowedAgent.cleanup(allowedAgent.agent);
  }
}

async function testDuplicateToolCallIdsStopBeforeExecution(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    return sseResponse([
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "duplicate-write", type: "function", function: { name: "write_file", arguments: "{\"path\":\"one.txt\",\"content\":\"one\"}" } },
        { index: 1, id: "duplicate-write", type: "function", function: { name: "write_file", arguments: "{\"path\":\"two.txt\",\"content\":\"two\"}" } }
      ] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register(writeTool(async () => { executeCount += 1; }));
  const { agent, cleanup, sessionFile } = await createAgent(registry);
  try {
    const events = await collect(runAgent(agent, "attempt duplicate calls"));
    assert.equal(requestCount, 1);
    assert.equal(executeCount, 0);
    const duplicateErrors = events.filter((event) => event.type === "error" && /duplicate tool call id/i.test(event.message));
    assert.equal(duplicateErrors.length, 1);
    assert.equal(duplicateErrors[0]?.fatal, true);
    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; toolCallId?: string });
    const toolCallIds = records.filter((event) => event.type === "tool_call").map((event) => event.toolCallId);
    assert.equal(new Set(toolCallIds).size, toolCallIds.length);
    assert.equal(records.filter((event) => event.type === "tool_call").length, records.filter((event) => event.type === "tool_result").length);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testCanonicalPermissionPathCannotBypassDeny(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requests.length === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "canonical-deny", type: "function", function: { name: "read_file", arguments: "{\"path\":\"alias/token.txt\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "denied safely" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-canonical-permission-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "private"));
    await writeFile(path.join(workspaceRoot, "private", "token.txt"), "not-a-real-private-value", "utf8");
    await symlink(path.join(workspaceRoot, "private"), path.join(workspaceRoot, "alias"));
    const config = configFor();
    config.permission.denyPaths = ["private/"];
    const registry = new ToolRegistry();
    registry.register(createReadFileTool({ workspaceRoot, ignore: [] }));
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
    let confirmationRequested = false;
    const events = await collect(runAgent(agent, "read the alias", async () => {
      confirmationRequested = true;
      return { approved: true, scope: "once" };
    }));
    assert.equal(confirmationRequested, false);
    assert.equal(events.some((event) => event.type === "done" && event.content === "denied safely"), true);
    assert.doesNotMatch(JSON.stringify(requests), /not-a-real-private-value/);
    await agent.close();
    const records = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { status?: string; targetPath?: string } });
    const denied = records.find((event) => event.type === "tool_result")?.result;
    assert.equal(denied?.status, "denied");
    assert.equal(denied?.targetPath, "private/token.txt");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
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

async function testParallelPermissionAbortSettlesAllCalls(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    return sseResponse([
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "abort-write-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"one.txt\",\"content\":\"one\"}" } },
        { index: 1, id: "abort-write-2", type: "function", function: { name: "write_file", arguments: "{\"path\":\"two.txt\",\"content\":\"two\"}" } }
      ] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register(writeTool(async () => {
    executeCount += 1;
  }));
  const controller = new AbortController();
  let confirmCount = 0;
  const { agent, cleanup, sessionFile } = await createAgent(registry);
  try {
    const events = await withTimeout(collect(runAgent(agent, "write two files", async () => {
      confirmCount += 1;
      queueMicrotask(() => controller.abort());
      return await new Promise<{ approved: boolean; scope: "once" | "tool" }>(() => undefined);
    }, controller.signal)), 2_000);

    assert.equal(requestCount, 1);
    assert.equal(confirmCount, 1);
    assert.equal(executeCount, 0);
    assert.equal(events.filter((event) => event.type === "error" && event.recorded).every((event) => event.fatal === false), true);
    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.equal(records.filter((event) => event.type === "tool_call").length, 2);
    assert.equal(records.filter((event) => event.type === "tool_result").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testPipelineAdmissionBoundsPermissionWaiters(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "bounded-write-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"one.txt\",\"content\":\"one\"}" } },
          { index: 1, id: "bounded-write-2", type: "function", function: { name: "write_file", arguments: "{\"path\":\"two.txt\",\"content\":\"two\"}" } },
          { index: 2, id: "bounded-write-3", type: "function", function: { name: "write_file", arguments: "{\"path\":\"three.txt\",\"content\":\"three\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "unexpected continuation" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let resolveCount = 0;
  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "Write a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    schema: z.object({ path: z.string(), content: z.string() }),
    risk: "write",
    resolveExecution(args: { path: string; content: string }) {
      resolveCount += 1;
      return {
        approvalRule: "write_file",
        async execute() {
          executeCount += 1;
          return { path: args.path };
        }
      };
    }
  } as Tool);
  const controller = new AbortController();
  const permissionStarted = deferred<void>();
  let confirmCount = 0;
  const { agent, cleanup, sessionFile } = await createAgent(registry, (config) => {
    config.agent.maxConcurrentTools = 1;
    config.agent.maxQueuedToolCalls = 1;
  });
  try {
    const eventsPromise = collect(runAgent(agent, "write three files", async () => {
      confirmCount += 1;
      permissionStarted.resolve(undefined);
      return await new Promise<AgentPermissionResult>(() => undefined);
    }, controller.signal));
    await withTimeout(permissionStarted.promise, 2_000);
    await delay(20);
    controller.abort();
    await withTimeout(eventsPromise, 2_000);

    assert.equal(requestCount, 1);
    assert.equal(resolveCount, 1, "queued and rejected calls must not reach resolveExecution");
    assert.equal(confirmCount, 1, "only the admitted pipeline may reach the permission gate");
    assert.equal(executeCount, 0);
    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { error?: string } });
    assert.equal(records.filter((event) => event.type === "tool_call").length, 3);
    assert.equal(records.filter((event) => event.type === "tool_result").length, 3);
    assert.equal(records.some((event) => event.type === "tool_result" && /queue is full/i.test(event.result?.error ?? "")), true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testAbortQuarantinesExternalResolveUntilLateSettlement(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "stuck-resolve", type: "function", function: { name: "write_file", arguments: "{\"path\":\"resolve.txt\",\"content\":\"content\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "recovered after resolve" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const resolutionStarted = deferred<void>();
  const lateResolution = deferred<void>();
  let confirmCount = 0;
  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "Resolve a plugin tool asynchronously.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    schema: z.object({ path: z.string(), content: z.string() }),
    risk: "write",
    async resolveExecution(args: { path: string; content: string }) {
      resolutionStarted.resolve(undefined);
      await lateResolution.promise;
      return {
        approvalRule: "write_file",
        async execute() {
          executeCount += 1;
          return { path: args.path };
        }
      };
    }
  } as Tool, "plugin");
  const controller = new AbortController();
  const { agent, cleanup, sessionFile } = await createAgent(registry);
  try {
    const eventsPromise = collect(runAgent(agent, "resolve an external tool", async () => {
      confirmCount += 1;
      return { approved: true, scope: "once" };
    }, controller.signal));
    await withTimeout(resolutionStarted.promise, 2_000);
    controller.abort();
    const events = await withTimeout(eventsPromise, 2_000);

    assert.equal(requestCount, 1);
    assert.equal(confirmCount, 0, "permission must not run before external resolution completes");
    assert.equal(executeCount, 0);
    assert.equal(events.some((event) => event.type === "error" && /resolveExecution did not settle/i.test(event.message)), true);
    await assert.rejects(collect(runAgent(agent, "must wait for resolution")), /session is quarantined/i);
    assert.equal(requestCount, 1);

    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { status?: string; quarantined?: boolean; stage?: string } });
    assert.equal(records.filter((event) => event.type === "tool_call").length, 1);
    assert.equal(records.filter((event) => event.type === "tool_result").length, 1);
    const result = records.find((event) => event.type === "tool_result")?.result;
    assert.equal(result?.status, "aborted");
    assert.equal(result?.quarantined, true);
    assert.equal(result?.stage, "resolveExecution");

    lateResolution.resolve(undefined);
    await delay(0);
  } finally {
    lateResolution.resolve(undefined);
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testAbortQuarantinesExternalToolUntilLateSettlement(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount > 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "stuck-write", type: "function", function: { name: "write_file", arguments: "{\"path\":\"stuck.txt\",\"content\":\"content\"}" } }
      ] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  const started = deferred<void>();
  const lateSettlement = deferred<void>();
  const registry = new ToolRegistry();
  registry.register(writeTool(async () => {
    started.resolve(undefined);
    await lateSettlement.promise;
  }), "plugin");
  const controller = new AbortController();
  const { agent, cleanup, sessionFile } = await createAgent(registry);
  try {
    const eventsPromise = collect(runAgent(agent, "write a file", async () => ({ approved: true, scope: "once" }), controller.signal));
    await withTimeout(started.promise, 2_000);
    controller.abort();
    const events = await withTimeout(eventsPromise, 2_000);

    assert.equal(requestCount, 1);
    assert.equal(events.some((event) => event.type === "error" && event.recorded && event.fatal === false && /quarantined/i.test(event.message)), true);
    await assert.rejects(collect(runAgent(agent, "must not overlap")), /session is quarantined/i);
    assert.throws(() => agent.recordHostedToolCall("delegate_task", { task: "must not overlap" }, "blocked-subagent"), /session is quarantined/i);
    assert.equal(requestCount, 1, "a quarantined run must be rejected before a provider request");

    lateSettlement.resolve(undefined);
    await delay(0);
    const recoveredEvents = await collect(runAgent(agent, "run after late settlement"));
    assert.equal(requestCount, 2);
    assert.equal(recoveredEvents.some((event) => event.type === "done" && event.content === "recovered"), true);

    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { status?: string; quarantined?: boolean; error?: string } });
    assert.equal(records.filter((event) => event.type === "tool_call").length, 1);
    assert.equal(records.filter((event) => event.type === "tool_result").length, 1);
    const quarantinedResult = records.find((event) => event.type === "tool_result")?.result;
    assert.equal(quarantinedResult?.status, "aborted");
    assert.equal(quarantinedResult?.quarantined, true);
    assert.match(quarantinedResult?.error ?? "", /cannot overlap its possible side effects/i);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testCloseDoesNotWaitForQuarantinedExternalTool(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => sseResponse([
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "never-settles", type: "function", function: { name: "write_file", arguments: "{\"path\":\"never.txt\",\"content\":\"content\"}" } }
    ] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]"
  ])) as typeof fetch;

  const started = deferred<void>();
  const registry = new ToolRegistry();
  registry.register(writeTool(async () => {
    started.resolve(undefined);
    await new Promise<void>(() => undefined);
  }), "mcp");
  const controller = new AbortController();
  const { agent, cleanup } = await createAgent(registry);
  try {
    const eventsPromise = collect(runAgent(agent, "start an uncooperative external tool", undefined, controller.signal));
    await withTimeout(started.promise, 2_000);
    controller.abort();
    await withTimeout(eventsPromise, 2_000);
    await withTimeout(agent.close(), 250);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testAbortDrainsCooperativeBuiltinTool(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => sseResponse([
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "drain-write", type: "function", function: { name: "write_file", arguments: "{\"path\":\"drain.txt\",\"content\":\"content\"}" } }
    ] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]"
  ])) as typeof fetch;

  const started = deferred<void>();
  let stopped = false;
  const registry = new ToolRegistry();
  registry.register(cooperativeWriteTool(started, () => { stopped = true; }));
  const controller = new AbortController();
  const { agent, cleanup } = await createAgent(registry);
  try {
    const eventsPromise = collect(runAgent(agent, "write a file", async () => ({ approved: true, scope: "once" }), controller.signal));
    await withTimeout(started.promise, 2_000);
    const abortedAt = Date.now();
    controller.abort();
    await withTimeout(eventsPromise, 2_000);
    assert.equal(stopped, true);
    assert.ok(Date.now() - abortedAt >= 70, "the builtin resource must remain held until its abort cleanup settles");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent);
  }
}

async function testStalePermissionPreviewPreventsExecution(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "stale-write", type: "function", function: { name: "write_file", arguments: "{\"path\":\"race.txt\",\"content\":\"agent\"}" } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: "retry required" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]"
    ]);
  }) as typeof fetch;

  let executeCount = 0;
  const registry = new ToolRegistry();
  registry.register(writeTool(async () => {
    executeCount += 1;
  }));
  const { agent, cleanup, permissionManager, sessionFile, workspaceRoot } = await createAgent(registry);
  try {
    const events = await collect(runAgent(agent, "write race.txt", async () => {
      await writeFile(path.join(workspaceRoot, "race.txt"), "external", "utf8");
      return { approved: true, scope: "tool" };
    }));

    assert.equal(requestCount, 2);
    assert.equal(executeCount, 0);
    assert.equal(await readFile(path.join(workspaceRoot, "race.txt"), "utf8"), "external");
    assert.equal(events.some((event) => event.type === "error" && event.fatal === false && /target changed/i.test(event.message)), true);
    assert.equal(permissionManager.getStatus().sessionAllowTools.includes("write_file"), false);
    await agent.close();
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; result?: { stalePreview?: boolean } });
    assert.equal(records.find((event) => event.type === "tool_result")?.result?.stalePreview, true);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
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

  const { agent, cleanup, sessionFile } = await createAgent();
  const controller = new AbortController();
  controller.abort();
  try {
    const events = await collect(runAgent(agent, "hi", undefined, controller.signal));
    assert.equal(calls, 0);
    assert.equal(events.some((event) => event.type === "error"), true);
    assert.equal(events.some((event) => event.type === "done" && event.content === ""), true);
    await agent.close();
    const sessionEvents = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; content?: string });
    assert.equal(sessionEvents[0]?.type, "user_message");
    assert.equal(sessionEvents[0]?.content, "hi");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testPreAbortedPlanRecordsAttempt(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return sseResponse([{ choices: [{ index: 0, delta: { content: "unexpected" }, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;

  const { agent, cleanup, sessionFile } = await createAgent();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(agent.createPlan("inspect cancellation", undefined, controller.signal), /interrupted before execution/i);
    assert.equal(calls, 0);
    await agent.close();
    const sessionEvents = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; content?: string });
    assert.deepEqual(sessionEvents.map((event) => event.type), ["user_message", "error"]);
    assert.equal(sessionEvents[0]?.content, "plan: inspect cancellation");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup(agent, true);
  }
}

async function testConsumerReturnAbortsAndDrainsStream(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const started = deferred<void>();
  const aborted = deferred<void>();
  const encoder = new TextEncoder();
  let shouldHang = true;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!shouldHang) {
      return sseResponse([
        { choices: [{ index: 0, delta: { content: "after cancel" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        "[DONE]"
      ]);
    }
    started.resolve(undefined);
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`));
        const stop = (): void => {
          aborted.resolve(undefined);
          try {
            controller.error(signal?.reason ?? new Error("aborted"));
          } catch {
            // The SDK may cancel the body before the fetch abort listener runs.
          }
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      },
      cancel() {
        aborted.resolve(undefined);
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const { agent, cleanup } = await createAgent();
  try {
    const iterator = agent.run("start a long response")[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, "status");
    const second = iterator.next();
    await started.promise;
    assert.equal((await second).done, false);

    await iterator.return?.();
    await aborted.promise;
    shouldHang = false;
    const nextEvents = await collect(runAgent(agent, "run after cancellation"));
    assert.equal(nextEvents.some((event) => event.type === "done" && event.content === "after cancel"), true);
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

function writeTool(onExecute: () => Promise<void>): Tool {
  return {
    name: "write_file",
    description: "Write a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    schema: z.object({ path: z.string(), content: z.string() }),
    resolveExecution(args: { path: string; content: string }) {
      return {
        approvalRule: "write_file",
        async execute() {
          await onExecute();
          return { path: args.path };
        }
      };
    }
  } as Tool;
}

function cooperativeWriteTool(started: { promise: Promise<void>; resolve(value: void | PromiseLike<void>): void }, onStopped: () => void): Tool {
  return {
    ...writeTool(async () => undefined),
    capability: "filesystem.write",
    resolveExecution(_args: { path: string; content: string }) {
      return {
        approvalRule: "write_file",
        async execute({ signal }: { signal?: AbortSignal }) {
          started.resolve(undefined);
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              setTimeout(resolve, 80);
              return;
            }
            signal?.addEventListener("abort", () => setTimeout(resolve, 80), { once: true });
          });
          onStopped();
          throw new DOMException("The operation was aborted.", "AbortError");
        }
      };
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

async function createAgent(
  registry = new ToolRegistry(),
  configure?: (config: AgentConfig) => void
): Promise<{ agent: AgentSession; permissionManager: PermissionManager; sessionFile: string; workspaceRoot: string; cleanup: (agent: AgentSession, alreadyClosed?: boolean) => Promise<void> }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sdk-runtime-"));
  await ensureAgentDirs(workspaceRoot);
  const config = configFor();
  configure?.(config);
  const recorder = new SessionRecorder(workspaceRoot);
  const permissionManager = new PermissionManager(config.permission);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model: createLanguageModelForConfig(config),
    toolRegistry: registry,
    permissionManager,
    recorder
  });
  await agent.initialize();
  return {
    agent,
    permissionManager,
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
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>,
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${String(timeoutMs)}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

await main();
