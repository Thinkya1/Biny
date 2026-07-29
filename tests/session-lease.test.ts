import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLeaseError, SessionLeaseStore } from "../src/runtime/SessionLease.js";

async function main(): Promise<void> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-lease-"));
  let first: SessionLeaseStore | undefined;
  let second: SessionLeaseStore | undefined;
  try {
    first = await SessionLeaseStore.open(workspaceRoot);
    second = await SessionLeaseStore.open(workspaceRoot);
    const lease = first.acquire("session-1");
    assert.throws(() => first!.acquire("session-1"), /already leased/u);
    assert.throws(() => second!.acquire("session-1"), SessionLeaseError);
    lease.close();

    const replacement = second.acquire("session-1");
    replacement.close();
    assert.throws(() => second!.acquire("../escape"), /Invalid session id/u);
  } finally {
    first?.close();
    second?.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
