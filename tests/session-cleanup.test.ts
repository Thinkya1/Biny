import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { SessionRunLedger } from "../src/session/runLedger.js";
import { TurnStore } from "../src/session/turnStore.js";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-cleanup-"));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "cleanup-session");
  recorder.record({ type: "user_message", content: "cleanup" });
  await recorder.close();

  await new TurnStore(root, recorder.sessionId).save("cleanup", undefined, [{ role: "user", content: "cleanup" }], 0);
  const ledger = new SessionRunLedger(root);
  await ledger.start({ runId: "cleanup-run", sessionId: recorder.sessionId });
  await deleteSessionArtifacts(root, recorder.sessionId);

  await assert.rejects(access(sessionFilePath(root, recorder.sessionId)));
  await assert.rejects(access(path.join(agentDir(root), "turns", `${recorder.sessionId}.json`)));
  assert.deepEqual(await ledger.listSessionRuns(recorder.sessionId), []);
  console.log("session cleanup tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
