import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { executeChatSlashCommand } from "../src/cli/commands/chatSlash.js";
import { withCliAbortSignal } from "../src/cli/sigint.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";

await testSigintAbortsAndCleansUp();
await testResolvedCancelledOperationStillRejects();
await testSuccessfulOperationCleansUp();
await testChatSlashSignalsReachLongRunningOperations();

async function testSigintAbortsAndCleansUp(): Promise<void> {
  const source = new EventEmitter();
  let observedSignal: AbortSignal | undefined;
  const operation = withCliAbortSignal(async (signal) => {
    observedSignal = signal;
    return await rejectOnAbort(signal);
  }, source);

  assert.equal(source.listenerCount("SIGINT"), 1);
  source.emit("SIGINT");
  await assert.rejects(operation, /Operation interrupted by SIGINT/);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(source.listenerCount("SIGINT"), 0);
}

async function testSuccessfulOperationCleansUp(): Promise<void> {
  const source = new EventEmitter();
  const result = await withCliAbortSignal(async (signal) => {
    assert.equal(signal.aborted, false);
    return "done";
  }, source);
  assert.equal(result, "done");
  assert.equal(source.listenerCount("SIGINT"), 0);
  assert.equal(source.emit("SIGINT"), false);
}

async function testResolvedCancelledOperationStillRejects(): Promise<void> {
  const source = new EventEmitter();
  const operation = withCliAbortSignal(async (signal) => await new Promise<string>((resolve) => {
    signal.addEventListener("abort", () => resolve("ignored cancellation"), { once: true });
  }), source);

  source.emit("SIGINT");
  await assert.rejects(operation, /Operation interrupted by SIGINT/);
  assert.equal(source.listenerCount("SIGINT"), 0);
}

async function testChatSlashSignalsReachLongRunningOperations(): Promise<void> {
  const expected = new AbortController().signal;
  const observed: AbortSignal[] = [];
  const runtime = {
    agent: {
      compactConversation: async (_hint: string | undefined, signal: AbortSignal | undefined) => {
        if (signal) observed.push(signal);
        return "compacted";
      },
      createPlan: async (_task: string, _onDelta: undefined, signal: AbortSignal | undefined) => {
        if (signal) observed.push(signal);
        return "planned";
      }
    },
    runSubagentTask: async (_task: string, options: { signal?: AbortSignal } | undefined) => {
      if (options?.signal) observed.push(options.signal);
      return "delegated";
    }
  } as unknown as CommandRuntime;
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await executeChatSlashCommand(runtime, "/subagent inspect", expected);
    await executeChatSlashCommand(runtime, "/review", expected);
    await executeChatSlashCommand(runtime, "/compact", expected);
    await executeChatSlashCommand(runtime, "/plan next", expected);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(observed, [expected, expected, expected, expected]);
}

async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
