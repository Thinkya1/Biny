import assert from "node:assert/strict";
import { RootRunScheduler } from "../src/runtime/RootRunScheduler.js";

await testExecutionFailureHandlerStillSettlesCompletion();
await testQueuedCancellationHandlerStillSettlesCompletion();

async function testExecutionFailureHandlerStillSettlesCompletion(): Promise<void> {
  const scheduler = new RootRunScheduler<{ runId: string }, string>({
    maxQueuedRuns: 1,
    execute: async () => {
      throw new Error("executor failed");
    },
    onQueuedCancellation: () => "cancelled",
    onExecutionFailure: () => {
      throw new Error("failure handler failed");
    }
  });
  const submitted = scheduler.submit({ runId: "run-1" });
  await assert.rejects(submitted.completion, /failure handler failed/u);
  await scheduler.waitForIdle();
}

async function testQueuedCancellationHandlerStillSettlesCompletion(): Promise<void> {
  const scheduler = new RootRunScheduler<{ runId: string }, string>({
    maxQueuedRuns: 2,
    execute: async (_run, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "active aborted";
    },
    onQueuedCancellation: () => {
      throw new Error("cancellation handler failed");
    },
    onExecutionFailure: () => "failed"
  });
  const first = scheduler.submit({ runId: "run-1" });
  await waitUntil(() => scheduler.activeRun?.runId === "run-1");
  const queued = scheduler.submit({ runId: "run-2" });
  assert.equal(scheduler.cancel("run-2"), true);
  await assert.rejects(queued.completion, /cancellation handler failed/u);
  scheduler.close();
  assert.equal(await first.completion, "active aborted");
  await scheduler.waitForIdle();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler activity.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
