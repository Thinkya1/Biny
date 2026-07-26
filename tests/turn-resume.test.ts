import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-turn-"));
  try {
    await ensureAgentDirs(root);
    await testRoundTripKeepsToolResults(root);
    await testClearedTurnIsNotResumable(root);
    await testCorruptStateIsIgnored(root);
    await testIsolatedPerSession(root);
    console.log("turn resume tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 续跑的价值全在这里：已完成步骤的工具结果必须原样带回，否则等于重跑。 */
async function testRoundTripKeepsToolResults(root: string): Promise<void> {
  const store = new TurnStore(root, "session-a");
  const messages: ModelMessage[] = [
    { role: "user", content: "refactor the parser" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "file body" } }] }
  ];
  await store.save("refactor the parser", messages, 3);

  const loaded = await new TurnStore(root, "session-a").load();
  assert.equal(loaded?.completedSteps, 3);
  assert.equal(loaded?.prompt, "refactor the parser");
  assert.equal(loaded?.messages.length, 3);
  const toolMessage = loaded?.messages[2];
  assert.equal(toolMessage?.role, "tool");
  assert.equal(JSON.stringify(toolMessage).includes("file body"), true, "tool results must survive the round trip");
}

/** 陈旧的在途状态比没有更糟：它会让下一次启动去续跑一个早已完成的回合。 */
async function testClearedTurnIsNotResumable(root: string): Promise<void> {
  const store = new TurnStore(root, "session-b");
  await store.save("done work", [{ role: "user", content: "x" }], 1);
  assert.notEqual(await store.load(), undefined);
  await store.clear();
  assert.equal(await store.load(), undefined);
  // 清两次不该报错：正常收尾和异常收尾都可能走到这里。
  await store.clear();
}

async function testCorruptStateIsIgnored(root: string): Promise<void> {
  const store = new TurnStore(root, "session-c");
  const target = path.join(root, ".agent", "turns", "session-c.json");
  await (await import("node:fs/promises")).writeFile(target, "{ not json");
  assert.equal(await store.load(), undefined);
  // 空 messages 不构成可续跑的状态。
  await (await import("node:fs/promises")).writeFile(target, JSON.stringify({ turn: { sessionId: "session-c", prompt: "p", messages: [], completedSteps: 1 } }));
  assert.equal(await store.load(), undefined);
}

async function testIsolatedPerSession(root: string): Promise<void> {
  await new TurnStore(root, "session-d").save("d work", [{ role: "user", content: "d" }], 1);
  assert.equal(await new TurnStore(root, "session-e").load(), undefined);
}

await main();
