import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { fetchModelCatalog, parseModelCatalog } from "../src/ai/modelCatalog.js";
import { createRetryFetch } from "../src/ai/retry.js";
import { providerDefinition } from "../src/ai/provider.js";
import { configSchema, defaultConfig, type AgentConfig, type ModelProvider } from "../src/config/schema.js";
import { createModelSettings } from "../src/llm/factory.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type RequestHandler = (request: RecordedRequest, response: ServerResponse<IncomingMessage>) => Promise<void>;

async function main(): Promise<void> {
  await testRealProviderAdaptersAgainstLocalContracts();
  await testDynamicModelCatalogContracts();
  await testLargeAttachmentAssembly();
  await testRetryAndCancellationContracts();
  console.log("ai provider contract tests passed");
}

async function testRealProviderAdaptersAgainstLocalContracts(): Promise<void> {
  const requests: RecordedRequest[] = [];
  let openaiAttempts = 0;
  await withHttpServer(async (request, response) => {
    requests.push(request);
    if (request.url === "/v1/chat/completions" && request.headers.get("authorization") === "Bearer openai-contract-key") {
      openaiAttempts += 1;
      if (openaiAttempts === 1) {
        response.writeHead(503).end();
        return;
      }
    }
    if (request.url.endsWith("/messages")) {
      writeJson(response, {
        type: "message",
        id: "message-contract",
        role: "assistant",
        model: "claude-contract",
        content: [{ type: "text", text: "anthropic ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 }
      });
      return;
    }
    writeJson(response, {
      choices: [{ index: 0, message: { role: "assistant", content: "openai-compatible ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    });
  }, async (baseUrl) => {
    const openai = configFor({
      type: "openai",
      baseUrl: `${baseUrl}/v1`,
      apiKey: "openai-contract-key",
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 }
    });
    const openaiSettings = createModelSettings(openai);
    const openaiResult = await generateText({
      model: openaiSettings.model,
      messages: [{ role: "user", content: "hello openai" }],
      maxRetries: 0
    });
    assert.equal(openaiResult.text, "openai-compatible ok");

    const deepseek = configFor({
      type: "deepseek",
      baseUrl: `${baseUrl}/v1`,
      apiKey: "deepseek-contract-key",
      thinking: { efforts: ["high", "max"], defaultEffort: "max" },
      globalThinking: { enabled: true, effort: "max" }
    });
    const deepseekSettings = createModelSettings(deepseek);
    await generateText({
      model: deepseekSettings.model,
      providerOptions: deepseekSettings.providerOptions,
      messages: [{ role: "user", content: "hello deepseek" }],
      maxRetries: 0
    });

    const anthropic = configFor({ type: "anthropic", baseUrl: baseUrl, apiKey: "anthropic-contract-key", model: "claude-contract" });
    const anthropicSettings = createModelSettings(anthropic);
    const anthropicResult = await generateText({
      model: anthropicSettings.model,
      allowSystemInMessages: true,
      messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "hello anthropic" }],
      maxOutputTokens: 4_096,
      maxRetries: 0
    });
    assert.equal(anthropicResult.text, "anthropic ok");
  });
  assert.equal(openaiAttempts, 2);

  const openaiRequest = requests.find((request) => request.url === "/v1/chat/completions");
  assert.ok(openaiRequest);
  assert.equal(openaiRequest.headers.get("authorization"), "Bearer openai-contract-key");
  assert.equal(openaiRequest.body.model, "test-model");
  assert.deepEqual(openaiRequest.body.messages, [{ role: "user", content: "hello openai" }]);

  const deepseekRequest = requests.find((request) => request.url === "/v1/chat/completions" && request.headers.get("authorization") === "Bearer deepseek-contract-key");
  assert.ok(deepseekRequest);
  assert.deepEqual(deepseekRequest.body.thinking, { type: "enabled" });
  assert.equal(deepseekRequest.body.reasoning_effort, "max");

  const anthropicRequest = requests.find((request) => request.url.endsWith("/messages"));
  assert.ok(anthropicRequest);
  assert.equal(anthropicRequest.headers.get("x-api-key"), "anthropic-contract-key");
  assert.equal(anthropicRequest.headers.get("anthropic-version"), "2023-06-01");
  assert.deepEqual(anthropicRequest.body.system, [{ type: "text", text: "Be concise." }]);
  assert.deepEqual((anthropicRequest.body.messages as Array<Record<string, unknown>>)[0], { role: "user", content: [{ type: "text", text: "hello anthropic" }] });
}

async function testDynamicModelCatalogContracts(): Promise<void> {
  let openaiCatalogAttempts = 0;
  await withHttpServer(async (request, response) => {
    if (request.url === "/catalog/openai") {
      openaiCatalogAttempts += 1;
      if (openaiCatalogAttempts === 1) {
        response.writeHead(503).end();
        return;
      }
      assert.equal(request.headers.get("authorization"), "Bearer catalog-key");
      writeJson(response, {
        data: [{
          id: "gateway-vision",
          name: "Gateway Vision",
          context_length: 131_072,
          max_completion_tokens: 16_384,
          supports_tools: true,
          supports_reasoning: true,
          modalities: ["text", "image", "audio"],
          reasoning_efforts: ["low", "max"]
        }]
      });
      return;
    }
    assert.equal(request.headers.get("authorization"), "Bearer oauth-token");
    assert.equal(request.headers.get("x-api-key"), null);
    writeJson(response, { data: [{ id: "claude-catalog", display_name: "Claude Catalog" }] });
  }, async (baseUrl) => {
    const openai = configSchema.parse({
      ...defaultConfig,
      providers: {
        catalog: {
          type: "openai-compatible",
          baseUrl: `${baseUrl}/v1`,
          apiKey: "catalog-key",
          modelsEndpoint: `${baseUrl}/catalog/openai`,
          retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 }
        }
      },
      models: { catalog: { provider: "catalog", model: "gateway-vision" } },
      defaultModel: "catalog",
      thinking: { enabled: false, effort: "high" }
    });
    const entries = await fetchModelCatalog({
      alias: "catalog",
      config: openai.providers.catalog!,
      definition: providerDefinition("openai-compatible")
    });
    assert.deepEqual(entries[0], {
      id: "gateway-vision",
      displayName: "Gateway Vision",
      provider: "catalog",
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      capabilities: { tools: true, reasoning: true, vision: true, audio: true, streaming: true },
      reasoningEfforts: ["low", "max"]
    });

    const anthropic = configSchema.parse({
      ...defaultConfig,
      providers: {
        catalog: {
          type: "claude-subscription",
          baseUrl,
          apiKey: "oauth-token",
          authMode: "oauth-bearer",
          oauth: { provider: "claude-code", expiresAt: Date.now() + 60_000 },
          modelsEndpoint: `${baseUrl}/catalog/anthropic`
        }
      },
      models: { catalog: { provider: "catalog", model: "claude-catalog" } },
      defaultModel: "catalog",
      thinking: { enabled: false, effort: "high" }
    });
    const anthropicEntries = await fetchModelCatalog({
      alias: "catalog",
      config: anthropic.providers.catalog!,
      definition: providerDefinition("claude-subscription")
    });
    assert.equal(anthropicEntries[0]?.id, "claude-catalog");
  });
  assert.equal(openaiCatalogAttempts, 2);

  const parsed = parseModelCatalog({ data: [{ id: "anthropic-model" }] }, "anthropic", "anthropic");
  assert.deepEqual(parsed[0]?.reasoningEfforts, ["high", "max"]);
}

async function testLargeAttachmentAssembly(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-large-attachment-"));
  try {
    const memory = new ContextMemory(
      () => ({ specificationVersion: "v3", provider: "attachment-test", modelId: "attachment-test", supportedUrls: {} } as unknown as LanguageModel),
      new WorkspaceContext(workspaceRoot, [], 32 * 1024),
      undefined,
      24_000,
      32 * 1024
    );
    const data = Buffer.alloc(25 * 1024 * 1024, 0x41).toString("base64");
    const messages = await memory.prepareTurn("inspect the large image", "system", undefined, [{ name: "large.png", mimeType: "image/png", data }]);
    const user = messages.at(-1);
    assert.equal(user?.role, "user");
    assert.equal(Array.isArray(user?.content), true);
    const file = Array.isArray(user?.content) ? user.content.find((part) => part.type === "file") : undefined;
    assert.equal(file?.type, "file");
    assert.equal(file?.mediaType, "image/png");
    assert.deepEqual(file?.data, { type: "data", data });
    assert.equal((await memory.status()).budget.usedTokens <= 24_000, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testRetryAndCancellationContracts(): Promise<void> {
  let attempts = 0;
  const retryingFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 }, async () => {
    attempts += 1;
    return attempts === 1 ? new Response("retry", { status: 503 }) : new Response("ok", { status: 200 });
  });
  assert.equal((await retryingFetch("https://contract.test")).status, 200);
  assert.equal(attempts, 2);

  let clientErrorAttempts = 0;
  const noRetryForClientError = createRetryFetch({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 }, async () => {
    clientErrorAttempts += 1;
    return new Response("bad request", { status: 400 });
  });
  assert.equal((await noRetryForClientError("https://contract.test")).status, 400);
  assert.equal(clientErrorAttempts, 1);

  const controller = new AbortController();
  let cancelledAttempts = 0;
  const cancelledFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 5_000, maxDelayMs: 5_000 }, async () => {
    cancelledAttempts += 1;
    return new Response("temporarily unavailable", { status: 503 });
  });
  const pending = cancelledFetch("https://contract.test", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("retry cancelled")), 10);
  await assert.rejects(pending, /retry cancelled|abort/i);
  assert.equal(cancelledAttempts, 1);
}

function configFor(options: {
  type: ModelProvider;
  apiKey: string;
  baseUrl: string;
  model?: string;
  retry?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
  thinking?: { efforts: ["high", "max"]; defaultEffort: "max" };
  globalThinking?: { enabled: boolean; effort: "max" };
}): AgentConfig {
  return configSchema.parse({
    defaultModel: "test-model",
    providers: { active: { type: options.type, apiKey: options.apiKey, baseUrl: options.baseUrl, retry: options.retry } },
    models: {
      "test-model": {
        provider: "active",
        model: options.model ?? "test-model",
        thinking: options.thinking
      }
    },
    thinking: options.globalThinking ?? { enabled: false, effort: "max" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: { ...defaultConfig.context, memory: { enabled: false } }
  });
}

async function withHttpServer(handler: RequestHandler, callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    void readRequest(request).then((record) => handler(record, response)).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start local provider contract server.");
  try {
    await callback(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function readRequest(request: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    method: request.method ?? "",
    url: request.url ?? "",
    headers: new Headers(Object.entries(request.headers).flatMap(([name, value]) => value === undefined ? [] : [[name, Array.isArray(value) ? value.join(",") : value]])),
    body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}
  };
}

function writeJson(response: ServerResponse<IncomingMessage>, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

await main();
