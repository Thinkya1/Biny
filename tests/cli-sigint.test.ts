import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { withCliAbortSignal } from "../src/cli/sigint.js";

await testSigintAbortsAndCleansUp();
await testResolvedCancelledOperationStillRejects();
await testSuccessfulOperationCleansUp();

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

async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
