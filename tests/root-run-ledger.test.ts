import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RootRunLedger,
  RootRunLedgerLeaseError,
  RootRunLedgerTerminalStateError
} from "../src/runtime/RootRunLedger.js";

await testLifecyclePersistsWithoutPromptText();
await testSingleRuntimeLeaseAndCrashRecovery();
await testTerminalRecordsAreImmutable();

async function testLifecyclePersistsWithoutPromptText(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-root-run-ledger-"));
  let ledger: RootRunLedger | undefined;
  try {
    ledger = await RootRunLedger.open(workspaceRoot);
    ledger.admit({
      runId: "run-lifecycle",
      sessionId: "session-1",
      messageId: "message-1",
      mode: "chat",
      input: "implement this with apiKey=opaque-root-run-secret",
      queuedAt: "2026-07-19T00:00:00.000Z"
    });
    ledger.start("run-lifecycle", "2026-07-19T00:00:01.000Z");
    ledger.complete("run-lifecycle", {
      endedAt: "2026-07-19T00:00:03.000Z",
      durationMs: 2_000,
      usage: {
        operation: "agent",
        modelAlias: "test",
        provider: "test",
        model: "test/model",
        totalTokens: 12,
        pricingKnown: false
      },
      reason: undefined
    });

    const snapshot = ledger.getSnapshot("run-lifecycle");
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.durationMs, 2_000);
    assert.match(snapshot.inputDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(snapshot.transitions.map((transition) => transition.status), ["queued", "running", "completed"]);
    const rawRecord = await readFile(path.join(ledger.directoryPath, "root-run-run-lifecycle.json"), "utf8");
    assert.equal(rawRecord.includes("opaque-root-run-secret"), false);
    assert.equal(rawRecord.includes("implement this"), false);
  } finally {
    ledger?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testSingleRuntimeLeaseAndCrashRecovery(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-root-run-recovery-"));
  let first: RootRunLedger | undefined;
  let recovered: RootRunLedger | undefined;
  try {
    first = await RootRunLedger.open(workspaceRoot);
    first.admit({
      runId: "run-interrupted",
      sessionId: "session-2",
      messageId: "message-2",
      mode: "plan",
      input: "unfinished task",
      queuedAt: "2026-07-19T00:00:00.000Z"
    });
    first.start("run-interrupted", "2026-07-19T00:00:01.000Z");
    await assert.rejects(async () => await RootRunLedger.open(workspaceRoot), RootRunLedgerLeaseError);

    first.close();
    first = undefined;
    recovered = await RootRunLedger.open(workspaceRoot);
    const snapshot = recovered.getSnapshot("run-interrupted");
    assert.equal(snapshot.status, "aborted");
    assert.equal(snapshot.recovered, true);
    assert.match(snapshot.transitions.at(-1)?.reason ?? "", /Recovered after the previous interactive runtime/u);
  } finally {
    first?.close();
    recovered?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testTerminalRecordsAreImmutable(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-root-run-terminal-"));
  let ledger: RootRunLedger | undefined;
  try {
    ledger = await RootRunLedger.open(workspaceRoot);
    ledger.admit({
      runId: "run-terminal",
      sessionId: "session-3",
      messageId: "message-3",
      mode: "chat",
      input: "finish",
      queuedAt: "2026-07-19T00:00:00.000Z"
    });
    ledger.start("run-terminal", "2026-07-19T00:00:01.000Z");
    ledger.complete("run-terminal", {
      endedAt: "2026-07-19T00:00:02.000Z",
      durationMs: 1_000,
      usage: undefined,
      reason: undefined
    });
    assert.throws(
      () => ledger?.fail("run-terminal", {
        endedAt: "2026-07-19T00:00:03.000Z",
        durationMs: 2_000,
        usage: undefined,
        reason: "should not overwrite"
      }),
      RootRunLedgerTerminalStateError
    );
  } finally {
    ledger?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
