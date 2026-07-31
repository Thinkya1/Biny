import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig, configSchema } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { createNativeModelSettings } from "../src/llm/nativeFactory.js";
import { createNativeModel } from "../src/llm/nativeModel.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";

async function main(): Promise<void> {
  await testCompatibleSystemRole();
  await testFactoryProviderDefaults();
  await testAnthropicSubscriptionAndHistory();
  await testCompatibleReasoningPayloads();
  await testNativeTimeout();
  await testOpenAiResponsesTransport();
  const originalFetch = globalThis.fetch;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-native-agent-"));
  await ensureAgentDirs(workspaceRoot);
  let requestCount = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    requestCount += 1;
    const parts = requestCount === 1
      ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: '{"value":"ok"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
      ]
      : [
        { choices: [{ index: 0, delta: { content: "native answer" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ];
    return new Response([
      ...parts.map((part) => `data: ${JSON.stringify(part)}`),
      "data: [DONE]"
    ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const config = configSchema.parse({
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://example.test/v1" } },
    models: { "test-model": { provider: "active", model: "test-model" } },
    thinking: { enabled: false, effort: "high" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: { ...defaultConfig.context, memory: { enabled: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const registry = new ToolRegistry();
  const echoTool: Tool<{ value: string }, { value: string }> = {
    name: "echo",
    description: "Echo one value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    schema: z.object({ value: z.string() }),
    risk: "read",
    resolveExecution: (args) => ({
      approvalRule: "echo",
      execute: async () => ({ value: args.value })
    })
  };
  registry.registerBuiltinTool(echoTool);
  const agent = new AgentSession({
    workspaceRoot,
    config,
    modelManager: new ModelManager(workspaceRoot, config),
    toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    recorder
  });
  await agent.initialize();
  try {
    const events: AgentSessionEvent[] = [];
    for await (const event of agent.prompt("answer briefly", {
      confirmPermission: async () => ({ approved: true, scope: "once" })
    })) events.push(event);
    const done = events.find((event): event is Extract<AgentSessionEvent, { type: "done" }> => event.type === "done");
    assert.equal(requestCount, 2);
    assert.equal(done?.outcome.status, "completed");
    assert.equal(done?.content, "native answer");
    assert.equal(events.some((event) => event.type === "assistant.delta" && event.content === "native answer"), true);
    assert.equal(events.some((event) => event.type === "tool.completed" && event.tool === "echo"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testFactoryProviderDefaults(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (String(input).endsWith("/responses")) {
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const relayConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "relay-model",
      providers: { relay: { type: "openai", apiKey: "key", baseUrl: "https://relay.example/v1" } },
      models: { "relay-model": { provider: "relay", model: "relay-model", capabilities: { tools: true, reasoning: false, streaming: true }, thinkingLevelMap: { off: "none" } } },
      thinking: { enabled: false, effort: "high" }
    });
    const relay = createNativeModelSettings(relayConfig);
    for await (const _event of await relay.model.stream({ systemPrompt: "Rules", messages: [{ role: "user", content: "hi" }], tools: [] })) {
      // Drain the native stream.
    }
    assert.equal((requests[0]?.body.messages as Array<{ role?: string }>)[0]?.role, "system");

    const codexConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "codex-model",
      providers: { codex: { type: "openai-codex", apiKey: "oauth-token", baseUrl: "https://codex.example/backend-api/codex" } },
      models: { "codex-model": { provider: "codex", model: "codex-model", capabilities: { tools: true, reasoning: false, streaming: true }, thinkingLevelMap: { off: "none" } } },
      thinking: { enabled: false, effort: "high" }
    });
    const codex = createNativeModelSettings(codexConfig);
    for await (const _event of await codex.model.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
      // Drain the native stream.
    }
    assert.equal(requests[1]?.url, "https://codex.example/backend-api/codex/responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicSubscriptionAndHistory(): Promise<void> {
  let requestUrl = "";
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "claude-subscription",
    modelId: "claude-test",
    protocol: "anthropic",
    baseUrl: "https://example.test/anthropic/v1",
    apiKey: "oauth-token",
    anthropicAuthMode: "bearer",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const events = [];
  for await (const event of await model.stream({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "reasoning", text: "private thought", providerMetadata: { anthropic: { signature: "sig-1" } } }] }
    ],
    tools: []
  })) events.push(event);
  assert.equal(requestUrl, "https://example.test/anthropic/v1/messages");
  assert.equal(requestHeaders?.get("authorization"), "Bearer oauth-token");
  assert.equal(requestHeaders?.get("x-api-key"), null);
  assert.ok(requestHeaders?.get("anthropic-beta")?.includes("claude-code-20250219"));
  const messages = requestBody?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[1]?.content[0], { type: "thinking", thinking: "private thought", signature: "sig-1" });
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "ok"), true);
}

async function testNativeTimeout(): Promise<void> {
  const model = createNativeModel({
    provider: "timeout-test",
    modelId: "timeout-model",
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const timer = setTimeout(() => reject(new Error("request did not time out")), 1_000);
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    })
  });
  await assert.rejects(async () => {
    for await (const _event of await model.stream({ messages: [{ role: "user", content: "wait" }], tools: [] }, { timeoutMs: 20 })) {
      // The request must abort before yielding a response.
    }
  }, /timeout|aborted/iu);
}

async function testCompatibleReasoningPayloads(): Promise<void> {
  const bodies: Record<string, unknown>[] = [];
  const response = (): Response => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const qwen = createNativeModel({
    provider: "qwen",
    modelId: "qwen-test",
    protocol: "openai-compatible",
    reasoningProtocol: "alibaba",
    providerOptions: { alibaba: { enableThinking: true, thinkingBudget: 512 } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await qwen.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  assert.equal(bodies[0]?.enable_thinking, true);
  assert.equal(bodies[0]?.thinking_budget, 512);

  const kimi = createNativeModel({
    provider: "kimi",
    modelId: "kimi-k2.5",
    protocol: "openai-compatible",
    reasoningProtocol: "moonshotai",
    providerOptions: { moonshotai: { thinking: { type: "enabled" } } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await kimi.stream({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "reasoning", text: "keep this" }, { type: "text", text: "answer" }] }
    ],
    tools: []
  })) {
    // Drain the native stream.
  }
  assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
  assert.equal((bodies[1]?.messages as Array<Record<string, unknown>>)[1]?.reasoning_content, "keep this");

  const kimiK3 = createNativeModel({
    provider: "kimi",
    modelId: "kimi-k3",
    protocol: "openai-compatible",
    reasoningProtocol: "moonshotai",
    providerOptions: { moonshotai: { reasoningEffort: "max" } },
    baseUrl: "https://example.test/v1",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return response();
    }
  });
  for await (const _event of await kimiK3.stream({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  assert.equal(bodies[2]?.reasoning_effort, "max");
  assert.equal(bodies[2]?.thinking, undefined);
}

async function testCompatibleSystemRole(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "openai-compatible",
    modelId: "compat-model",
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    apiKey: "token",
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  for await (const _event of await model.stream({ systemPrompt: "Follow the rules.", messages: [{ role: "user", content: "hi" }], tools: [] })) {
    // Drain the native stream.
  }
  const messages = requestBody?.messages as Array<{ role?: string }> | undefined;
  assert.equal(messages?.[0]?.role, "system");
}

async function testOpenAiResponsesTransport(): Promise<void> {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const model = createNativeModel({
    provider: "openai-codex",
    modelId: "gpt-test",
    protocol: "openai-responses",
    baseUrl: "https://example.test/backend-api/codex",
    apiKey: "token",
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const body = [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"responses ok"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n'
      ].join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  const events = [];
  for await (const event of await model.stream({
    systemPrompt: "Follow the rules.",
    messages: [{ role: "user", content: "hello" }],
    tools: []
  })) events.push(event);
  assert.equal(requestUrl, "https://example.test/backend-api/codex/responses");
  assert.deepEqual(requestBody?.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.equal(events.some((event) => event.type === "text-delta" && event.text === "responses ok"), true);
  assert.deepEqual(events.find((event) => event.type === "finish"), {
    type: "finish",
    reason: "stop",
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, reasoningTokens: undefined }
  });
}

await main();
console.log("native agent tests passed");
