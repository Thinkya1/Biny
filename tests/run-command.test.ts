import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import { applyRunConfig, validateRunOptions } from "../src/cli/commands/run.js";

const config = structuredClone(defaultConfig);
const overridden = applyRunConfig(config, {
  model: "deepseek-v4-pro",
  maxSteps: 256,
  softSteps: 192,
  headless: true
});

assert.equal(overridden.defaultModel, "deepseek-v4-pro");
assert.equal(overridden.agent.hardStepLimit, 256);
assert.equal(overridden.agent.softStepLimit, 192);
assert.equal(overridden.permission.mode, "full-access");
assert.equal(overridden.permission.criticalAlwaysAsk, false);

assert.throws(
  () => validateRunOptions({ maxSteps: 64, softSteps: 65 }),
  /softSteps cannot be greater than maxSteps/
);
assert.throws(
  () => validateRunOptions({ maxSteps: 1_025 }),
  /maxSteps must be an integer between 1 and 1024/
);
assert.throws(
  () => validateRunOptions({ permissionMode: "safe" as never }),
  /permissionMode must be one of ask, read-only, auto, full-access/
);

console.log("run command tests passed");
