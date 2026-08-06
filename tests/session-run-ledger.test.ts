import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRunLedger } from "../src/session/runLedger.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-run-ledger-"));
try {
  const ledger = new SessionRunLedger(root);
  const started = await ledger.start({
    runId: "run-1",
    sessionId: "session-1",
    messageId: "message-1",
    startedAt: "2026-08-05T10:00:00.000Z"
  });
  assert.equal(started.status, "running");
  assert.equal((await ledger.latestSessionRun("session-1"))?.runId, "run-1");

  const finished = await ledger.finish("run-1", {
    status: "blocked",
    durationMs: 1250,
    stopReason: "blocked",
    steps: 3,
    resumable: true,
    blockedReason: "missing_user_input",
    requiredAction: "Choose a deployment target.",
    endedAt: "2026-08-05T10:00:01.250Z"
  });
  assert.equal(finished?.status, "blocked");
  assert.equal(finished?.durationMs, 1250);
  assert.equal(finished?.resumable, true);
  assert.equal((await ledger.finish("run-1", { status: "completed" }))?.status, "blocked");

  const runs = await ledger.listSessionRuns("session-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.requiredAction, "Choose a deployment target.");
  console.log("session run ledger tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
