import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-fork-"));
  try {
    await ensureAgentDirs(root);
    const source = await seedSession(root);
    await testFullForkIsIndependent(root, source);
    await testTruncatedForkNeverSplitsAToolCall(root, source);
    await testRejectsEmptyAndBadBounds(root);
    console.log("session fork tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedSession(root: string): Promise<string> {
  const recorder = new SessionRecorder(root);
  const events: SessionEvent[] = [
    { type: "user_message", content: "first request" },
    { type: "assistant_message", content: "first answer" },
    { type: "user_message", content: "second request" },
    { type: "tool_call", tool: "read_file", args: { path: "a.ts" }, toolCallId: "c1", sequence: 1 },
    { type: "tool_result", tool: "read_file", result: { content: "body" }, toolCallId: "c1", sequence: 1 },
    { type: "assistant_message", content: "second answer" }
  ];
  for (const event of events) recorder.record(event);
  await recorder.close();
  return recorder.sessionId;
}

/** 分叉出来的会话必须完全独立：写它不能影响原会话。 */
async function testFullForkIsIndependent(root: string, source: string): Promise<void> {
  const forked = await forkSession(root, source);
  assert.notEqual(forked.sessionId, source);
  assert.equal(forked.sourceSessionId, source);
  assert.equal(forked.events, 6);

  const replayed = await replaySession(forked.filePath);
  assert.equal(replayed.recoveredToolResults.length, 0, "a clean fork must not carry a synthetic interrupted result");

  const appended = new SessionRecorder(root, forked.sessionId, forked.filePath);
  appended.repairTailForAppend();
  appended.record({ type: "user_message", content: "only in the fork" });
  await appended.close();

  const original = await readFile(path.join(root, ".biny", "sessions", `${source}.jsonl`), "utf8");
  assert.equal(original.includes("only in the fork"), false, "writing the fork must not touch the source session");
}

/**
 * 停在 tool_call 和它的 tool_result 中间，重放会补一条"已中断"的假结果 —— 分叉出来的会话
 * 从第一步起就带着一个从未发生过的失败。截断点必须向前对齐。
 */
async function testTruncatedForkNeverSplitsAToolCall(root: string, source: string): Promise<void> {
  // 第 4 条正好是 tool_call，它的结果在第 5 条。
  const forked = await forkSession(root, source, { upToEvent: 4 });
  assert.equal(forked.events, 3, `expected the cut to move back before the tool call, got ${String(forked.events)} events`);

  const replayed = await replaySession(forked.filePath);
  assert.equal(replayed.recoveredToolResults.length, 0, "a truncated fork must not invent an interrupted tool result");
  assert.equal(replayed.messages.at(-1)?.role, "user");

  // 包含配对结果的截断点则原样保留。
  const withResult = await forkSession(root, source, { upToEvent: 5 });
  assert.equal(withResult.events, 5);
  assert.equal((await replaySession(withResult.filePath)).recoveredToolResults.length, 0);
}

async function testRejectsEmptyAndBadBounds(root: string): Promise<void> {
  const empty = new SessionRecorder(root);
  const emptyId = empty.sessionId;
  empty.record({ type: "user_message", content: "x" });
  await empty.close();
  await assert.rejects(forkSession(root, emptyId, { upToEvent: 0 }), /positive integer/);
  await assert.rejects(forkSession(root, "no-such-session"), /.+/);
}

await main();
