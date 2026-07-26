import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HookRunner } from "../src/tools/hooks.js";
import type { HooksConfig } from "../src/config/schema.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-hooks-"));
  try {
    await testFiltersByToolAndExtension(workspaceRoot);
    await testFailureIsReportedForBlocking(workspaceRoot);
    await testHookSeesTriggerContext(workspaceRoot);
    await testMissingCommandCountsAsFailure(workspaceRoot);
    console.log("hook tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function hooks(overrides: Partial<HooksConfig>): HooksConfig {
  return { beforeTool: [], afterTool: [], ...overrides };
}

async function testFiltersByToolAndExtension(workspaceRoot: string): Promise<void> {
  const runner = new HookRunner(workspaceRoot, hooks({
    afterTool: [
      { command: "echo ts-only", tools: [], extensions: [".ts"], timeoutMs: 30_000 },
      { command: "echo write-only", tools: ["write_file"], extensions: [], timeoutMs: 30_000 }
    ]
  }));
  assert.equal(runner.hasHooks("afterTool"), true);
  assert.equal(runner.hasHooks("beforeTool"), false);

  const both = await runner.run("afterTool", { tool: "write_file", path: "src/a.ts" });
  assert.deepEqual(both.map((outcome) => outcome.output), ["ts-only", "write-only"]);

  const extensionOnly = await runner.run("afterTool", { tool: "edit_file", path: "src/a.ts" });
  assert.deepEqual(extensionOnly.map((outcome) => outcome.output), ["ts-only"]);

  const neither = await runner.run("afterTool", { tool: "edit_file", path: "src/a.py" });
  assert.deepEqual(neither, []);
}

/** 阻止是钩子存在的意义；失败必须能被上层识别出来，而不是静默通过。 */
async function testFailureIsReportedForBlocking(workspaceRoot: string): Promise<void> {
  const runner = new HookRunner(workspaceRoot, hooks({
    beforeTool: [{ command: "echo 'protected file' >&2; exit 3", tools: [], extensions: [], timeoutMs: 30_000 }]
  }));
  const [outcome] = await runner.run("beforeTool", { tool: "write_file", path: "src/a.ts" });
  assert.equal(outcome?.exitCode, 3);
  assert.equal(outcome?.output.includes("protected file"), true);
}

/** 钩子拿不到触发上下文就写不出有针对性的命令。 */
async function testHookSeesTriggerContext(workspaceRoot: string): Promise<void> {
  const runner = new HookRunner(workspaceRoot, hooks({
    afterTool: [{ command: 'printf "%s|%s" "$BINY_HOOK_TOOL" "$BINY_HOOK_PATH"', tools: [], extensions: [], timeoutMs: 30_000 }]
  }));
  const [outcome] = await runner.run("afterTool", { tool: "edit_file", path: "src/deep/file.ts" });
  assert.equal(outcome?.output, "edit_file|src/deep/file.ts");
}

/** 配置了却因为命令不存在而静默通过，比明确报错危险得多。 */
async function testMissingCommandCountsAsFailure(workspaceRoot: string): Promise<void> {
  const runner = new HookRunner(workspaceRoot, hooks({
    beforeTool: [{ command: "definitely-not-a-real-command-xyz", tools: [], extensions: [], timeoutMs: 30_000 }]
  }));
  const [outcome] = await runner.run("beforeTool", { tool: "write_file", path: "a.ts" });
  assert.notEqual(outcome?.exitCode, 0);
}

await main();
