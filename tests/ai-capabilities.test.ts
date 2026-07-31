import assert from "node:assert/strict";
import { inferReasoningEfforts, modelCapabilities, modelContextBudget, modelThinkingLevelMap, nativeReasoningEffort, reasoningBudgetTokens, thinkingLevelMapForModel } from "../src/ai/capabilities.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { createRetryFetch } from "../src/ai/retry.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ModelResolver } from "../src/llm/ModelResolver.js";

const config = configSchema.parse({
  ...structuredClone(defaultConfig),
  defaultModel: "small",
  models: {
    small: {
      provider: "deepseek",
      model: "small-model",
      contextWindow: 16_384,
      maxOutputTokens: 4_096,
      capabilities: { tools: true, reasoning: true, vision: true, streaming: true },
      reasoning: {
        efforts: ["low", "high"],
        defaultEffort: "high",
        mapping: { low: "low", high: "high" },
        budgetTokens: { low: 1_024, high: 3_072 }
      }
    }
  },
  thinking: { enabled: false, effort: "high" }
});

const model = config.models.small!;
const budget = modelContextBudget(model, config.context.maxInputTokens, "small");
assert.equal(budget.contextWindow, 16_384);
assert.equal(budget.maxInputTokens, 12_288);
assert.equal(budget.maxOutputTokens, 4_096);
assert.equal(budget.modelAlias, "small");
assert.equal(modelCapabilities(model).vision, true);
assert.equal(nativeReasoningEffort(model, "high"), "high");
assert.equal(reasoningBudgetTokens(model, "high"), 3_072);

assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-flash"]!), { off: "none", high: "high", max: "max" });
assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-pro"]!), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-pro"), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-flash"), { off: "none", high: "high", max: "max" });
assert.deepEqual(thinkingLevelMapForModel("kimi-k3"), { low: "low", high: "high", max: "max" });

const registry = new ModelRegistry(structuredClone(defaultConfig));
registry.registerCatalog("deepseek", [{
  id: "deepseek-v4-pro-preview",
  displayName: "DeepSeek V4 Pro Preview",
  provider: "deepseek",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, reasoning: true, streaming: true },
  reasoningEfforts: ["low", "medium", "high"]
}]);
const catalogChoice = registry.listModels().find((choice) => choice.alias === "deepseek/deepseek-v4-pro-preview");
assert.equal(catalogChoice?.source, "catalog");
assert.deepEqual(catalogChoice?.efforts, ["low", "medium", "high"]);
assert.equal(new ModelResolver(registry).resolve("deepseek/deepseek-v4-pro-preview").source, "catalog");

const catalog = parseModelCatalog({
  data: [{
    id: "catalog-model",
    display_name: "Catalog Model",
    context_window: 131_072,
    max_tokens: 16_384,
    supports_tools: true,
    supports_vision: true,
    reasoning_efforts: ["low", "high"]
  }]
}, "gateway", "openai-compatible");
assert.deepEqual(catalog[0], {
  id: "catalog-model",
  displayName: "Catalog Model",
  provider: "gateway",
  contextWindow: 131_072,
  maxOutputTokens: 16_384,
  capabilities: { tools: true, reasoning: undefined, vision: true, audio: undefined, streaming: true },
  reasoningEfforts: ["low", "high"]
});

let attempts = 0;
const retryingFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 }, async () => {
  attempts += 1;
  return new Response("ok", { status: attempts === 1 ? 503 : 200 });
});
assert.equal((await retryingFetch("https://example.test")).status, 200);
assert.equal(attempts, 2);

// Relays and self-hosted gateways almost never declare reasoning_efforts, so
// well-known reasoning models must still surface thinking controls via the
// ID-based fallback — otherwise they silently show only a "default" level.
assert.deepEqual(inferReasoningEfforts("grok-4.5"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-5.4"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("claude-sonnet-4.6"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-flash"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-pro"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("kimi-k3"), ["low", "high", "max"]);
assert.deepEqual(inferReasoningEfforts("openai/gpt-5.4"), ["high", "max"]); // aggregator vendor prefix
assert.deepEqual(inferReasoningEfforts("grok-3-mini"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-4o-mini"), []);
assert.deepEqual(inferReasoningEfforts("llama-3.3-70b-instruct"), []);
assert.deepEqual(inferReasoningEfforts(""), []);

const relayCatalog = parseModelCatalog({
  data: [{ id: "grok-4.5" }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalog[0]?.reasoningEfforts, ["high", "max"]);
const relayCatalogNonReasoning = parseModelCatalog({
  data: [{ id: "llama-3.3-70b-instruct" }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalogNonReasoning[0]?.reasoningEfforts, []);
