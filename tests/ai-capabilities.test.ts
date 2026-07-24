import assert from "node:assert/strict";
import { modelCapabilities, modelContextBudget, nativeReasoningEffort, reasoningBudgetTokens } from "../src/ai/capabilities.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { createRetryFetch } from "../src/ai/retry.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";

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
