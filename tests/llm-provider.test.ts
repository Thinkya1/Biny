import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText, jsonSchema } from "ai";
import { CONFIG_FILE, ensureConfig, loadConfig, maxConfigFileBytes, saveConfig } from "../src/config/loader.js";
import { configSchema, defaultConfig, type AgentConfig, type ModelProvider } from "../src/config/schema.js";
import { createModelSettings, createLanguageModelForConfig } from "../src/llm/factory.js";
import { ModelManager } from "../src/llm/ModelManager.js";

async function main(): Promise<void> {
  await testProviderMappingsUseNativeSdkModels();
  await testOpenAiEndpointAuthAndModelPayload();
  await testDeepSeekThinkingOptions();
  await testReasoningControlsForOtherProviders();
  await testAnthropicMessagesAndToolSchema();
  await testMissingKeyAndCompatibilityEndpointAreHardErrors();
  await testModelSwitchValidatesBeforePersisting();
  await testConfigFileStorageBoundaries();
}

async function testConfigFileStorageBoundaries(): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-storage-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-outside-"));
  try {
    const configPath = path.join(workspaceRoot, CONFIG_FILE);
    await ensureConfig(workspaceRoot);
    if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

    await fs.chmod(configPath, 0o644);
    await loadConfig(workspaceRoot);
    if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

    const savedConfig = configSchema.parse({
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        deepseek: { ...defaultConfig.providers.deepseek, apiKey: "not-a-real-test-key" }
      }
    });
    await saveConfig(workspaceRoot, savedConfig);
    assert.equal((await loadConfig(workspaceRoot)).providers.deepseek?.apiKey, "not-a-real-test-key");
    if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

    const oversizedConfig = configSchema.parse({
      ...savedConfig,
      providers: {
        ...savedConfig.providers,
        oversized: { type: "openai", apiKey: "x".repeat(maxConfigFileBytes) }
      }
    });
    await assert.rejects(saveConfig(workspaceRoot, oversizedConfig), /exceeds the .*byte size limit/i);
    assert.equal((await loadConfig(workspaceRoot)).providers.deepseek?.apiKey, "not-a-real-test-key");

    await fs.writeFile(configPath, Buffer.alloc(maxConfigFileBytes + 1, 0x20), { mode: 0o600 });
    await assert.rejects(loadConfig(workspaceRoot), /exceeding the .*byte size limit/i);
    await saveConfig(workspaceRoot, savedConfig);

    const victim = path.join(outsideRoot, "victim.json");
    const victimContent = `${JSON.stringify(defaultConfig, null, 2)}\n`;
    await fs.writeFile(victim, victimContent, { encoding: "utf8", mode: 0o600 });
    await fs.rm(configPath);
    await fs.symlink(victim, configPath);
    await assert.rejects(loadConfig(workspaceRoot), /symbolic link or hardlink/);
    await assert.rejects(ensureConfig(workspaceRoot), /symbolic link or hardlink/);
    await assert.rejects(saveConfig(workspaceRoot, savedConfig), /symbolic link or hardlink/);
    assert.equal(await fs.readFile(victim, "utf8"), victimContent);

    await fs.rm(configPath);
    await fs.link(victim, configPath);
    await assert.rejects(loadConfig(workspaceRoot), /single-link regular file/);
    await assert.rejects(ensureConfig(workspaceRoot), /single-link regular file/);
    await assert.rejects(saveConfig(workspaceRoot, savedConfig), /single-link regular file/);
    assert.equal(await fs.readFile(victim, "utf8"), victimContent);

    await fs.rm(configPath);
    const aliasRoot = path.join(outsideRoot, "workspace-alias");
    await fs.symlink(workspaceRoot, aliasRoot);
    await ensureConfig(aliasRoot);
    assert.equal((await loadConfig(aliasRoot)).defaultModel, defaultConfig.defaultModel);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
}

async function testReasoningControlsForOtherProviders(): Promise<void> {
  const openai = configSchema.parse({
    defaultModel: "reasoning-model",
    providers: { active: { type: "openai", apiKey: "key" } },
    models: {
      "reasoning-model": {
        provider: "active",
        model: "o3-mini",
        thinking: { efforts: ["high", "max"], defaultEffort: "max" }
      }
    },
    thinking: { enabled: true, effort: "max" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: defaultConfig.context
  });
  const openaiSettings = createModelSettings(openai);
  assert.equal(openaiSettings.reasoning, "xhigh");
  assert.equal(openaiSettings.providerOptions?.openai?.reasoningEffort, "max");

  const anthropic = configSchema.parse({
    defaultModel: "reasoning-model",
    providers: { active: { type: "anthropic", apiKey: "key" } },
    models: {
      "reasoning-model": {
        provider: "active",
        model: "claude-sonnet",
        thinking: { efforts: ["high", "max"], defaultEffort: "high" }
      }
    },
    thinking: { enabled: true, effort: "high" },
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: defaultConfig.context
  });
  const anthropicSettings = createModelSettings(anthropic);
  assert.equal(anthropicSettings.providerOptions?.anthropic?.thinking?.type, "enabled");
  assert.equal(anthropicSettings.providerOptions?.anthropic?.thinking?.budgetTokens, 4_096);
}

async function testProviderMappingsUseNativeSdkModels(): Promise<void> {
  const cases: Array<{ type: ModelProvider; provider: string; baseUrl?: string; key?: string }> = [
    { type: "openai", provider: "openai.chat", key: "key" },
    { type: "anthropic", provider: "anthropic.messages", key: "key" },
    { type: "claude-subscription", provider: "anthropic.messages", key: "oauth-token" },
    { type: "openai-codex", provider: "openai.responses", key: "oauth-token" },
    { type: "deepseek", provider: "deepseek.chat", key: "key" },
    { type: "kimi", provider: "moonshotai.chat", key: "key" },
    { type: "qwen", provider: "alibaba.chat", key: "key" },
    { type: "gemini", provider: "gemini.chat", key: "key" },
    { type: "ollama", provider: "ollama.chat" },
    { type: "openai-compatible", provider: "openai-compatible.chat", baseUrl: "https://compat.example/v1", key: "key" }
  ];

  for (const item of cases) {
    const config = configFor({ type: item.type, apiKey: item.key, baseUrl: item.baseUrl });
    const model = createLanguageModelForConfig(config);
    assert.equal(model.provider, item.provider);
    assert.equal(model.modelId, "test-model");
  }
}

async function testOpenAiEndpointAuthAndModelPayload(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    return openAiResponse("ok");
  }) as typeof fetch;

  try {
    const config = configFor({ type: "openai", apiKey: "configured-key", baseUrl: "https://gateway.example/v1" });
    await generateText({ model: createLanguageModelForConfig(config), messages: [{ role: "user", content: "hello" }], maxRetries: 0 });
    assert.equal(request?.url, "https://gateway.example/v1/chat/completions");
    assert.equal(request?.headers.get("authorization"), "Bearer configured-key");
    assert.equal(request?.body.model, "test-model");
    assert.deepEqual(request?.body.messages, [{ role: "user", content: "hello" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDeepSeekThinkingOptions(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return bodies.length === 1 ? deepSeekResponse("ok", "reasoning") : openAiResponse("ok");
  }) as typeof fetch;

  try {
    const enabled = configFor({
      type: "deepseek",
      apiKey: "deepseek-key",
      thinking: { efforts: ["high", "max"], defaultEffort: "max" },
      globalThinking: { enabled: true, effort: "max" }
    });
    const enabledSettings = createModelSettings(enabled);
    const enabledResult = await generateText({ model: enabledSettings.model, providerOptions: enabledSettings.providerOptions, messages: [{ role: "user", content: "reason" }], maxRetries: 0 });
    assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
    assert.equal(bodies[0]?.reasoning_effort, "max");
    assert.equal(await enabledResult.reasoningText, "reasoning");

    const disabled = configFor({ type: "deepseek", apiKey: "deepseek-key", globalThinking: { enabled: false, effort: "high" } });
    const disabledSettings = createModelSettings(disabled);
    await generateText({ model: disabledSettings.model, providerOptions: disabledSettings.providerOptions, messages: [{ role: "user", content: "reason" }], maxRetries: 0 });
    assert.deepEqual(bodies[1]?.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in (bodies[1] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicMessagesAndToolSchema(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    return new Response(JSON.stringify({
      type: "message",
      id: "message-1",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const config = configFor({ type: "anthropic", apiKey: "anthropic-key", model: "claude-test" });
    await generateText({
      model: createLanguageModelForConfig(config),
      allowSystemInMessages: true,
      messages: [{ role: "system", content: "Follow the repository rules." }, { role: "user", content: "Read README.md" }],
      tools: {
        read_file: {
          description: "Read a workspace file.",
          inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false })
        }
      },
      maxOutputTokens: 4_096,
      maxRetries: 0
    });
    assert.equal(request?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request?.headers.get("x-api-key"), "anthropic-key");
    assert.equal(request?.headers.get("anthropic-version"), "2023-06-01");
    assert.deepEqual(request?.body.system, [{ type: "text", text: "Follow the repository rules." }]);
    const messages = request?.body.messages as Array<{ role: string; content: unknown }> | undefined;
    assert.equal(messages?.[0]?.role, "user");
    const tools = request?.body.tools as Array<{ input_schema?: unknown }> | undefined;
    assert.equal((tools?.[0]?.input_schema as { properties?: unknown })?.properties !== undefined, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testMissingKeyAndCompatibilityEndpointAreHardErrors(): Promise<void> {
  const previous = process.env.BINY_TEST_OPENAI_KEY;
  delete process.env.BINY_TEST_OPENAI_KEY;
  try {
    assert.throws(
      () => createLanguageModelForConfig(configFor({ type: "openai", apiKey: undefined, apiKeyEnv: "BINY_TEST_OPENAI_KEY" })),
      /No model available.*BINY_TEST_OPENAI_KEY/
    );
    assert.throws(
      () => createLanguageModelForConfig(configFor({ type: "openai-compatible", apiKey: "key", baseUrl: undefined })),
      /openai-compatible requires|No model endpoint configured/
    );
  } finally {
    if (previous === undefined) delete process.env.BINY_TEST_OPENAI_KEY;
    else process.env.BINY_TEST_OPENAI_KEY = previous;
  }
}

async function testModelSwitchValidatesBeforePersisting(): Promise<void> {
  const config = configSchema.parse({
    ...defaultConfig,
    providers: {
      deepseek: { ...defaultConfig.providers.deepseek, apiKey: "deepseek-key" },
      openai: { type: "openai", apiKeyEnv: "BINY_TEST_MISSING_SWITCH_KEY" }
    },
    models: {
      ...defaultConfig.models,
      "openai-test": { provider: "openai", model: "gpt-test" }
    }
  });
  const previous = process.env.BINY_TEST_MISSING_SWITCH_KEY;
  delete process.env.BINY_TEST_MISSING_SWITCH_KEY;
  try {
    const manager = new ModelManager("/tmp/biny-provider-test", config);
    assert.rejects(() => manager.switchModel("openai-test"), /BINY_TEST_MISSING_SWITCH_KEY/);
    assert.equal(manager.getInfo().modelAlias, config.defaultModel);
  } finally {
    if (previous === undefined) delete process.env.BINY_TEST_MISSING_SWITCH_KEY;
    else process.env.BINY_TEST_MISSING_SWITCH_KEY = previous;
  }
}

function configFor(options: {
  type: ModelProvider;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  thinking?: { efforts: ["high", "max"] | ["high"] | ["max"]; defaultEffort: "high" | "max" };
  globalThinking?: { enabled: boolean; effort: "high" | "max" };
}): AgentConfig {
  const provider = {
    type: options.type,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    baseUrl: options.baseUrl
  };
  const modelThinking = options.type === "deepseek"
    ? options.thinking ?? { efforts: ["high", "max"] as ["high", "max"], defaultEffort: "high" as const }
    : undefined;
  const globalThinking = options.globalThinking ?? { enabled: false, effort: "high" as const };
  return configSchema.parse({
    defaultModel: "test-model",
    providers: { active: provider },
    models: { "test-model": { provider: "active", model: options.model ?? "test-model", thinking: modelThinking } },
    thinking: globalThinking,
    permission: defaultConfig.permission,
    workspace: defaultConfig.workspace,
    context: { ...defaultConfig.context, memory: { enabled: false } }
  });
}

function openAiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function deepSeekResponse(content: string, reasoning: string): Response {
  return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

await main();
