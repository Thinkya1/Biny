import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSessionTree, getSessionCatalogItem, listSessionCatalog, querySessionCatalog, readSessionCatalogRecord, readSessionTree, SessionCatalogConflictError, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-catalog-"));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "catalog root" });
  recorder.record({ type: "assistant_message", content: "root answer" });
  await recorder.close();

  const forked = await forkSession(root, recorder.sessionId);
  const catalog = await listSessionCatalog(root);
  const source = catalog.find((item) => item.id === recorder.sessionId);
  const child = catalog.find((item) => item.id === forked.sessionId);
  assert.ok(source);
  assert.ok(child);
  assert.equal(source.rootSessionId, source.id);
  assert.equal(child.parentSessionId, source.id);
  assert.equal(child.rootSessionId, source.id);
  assert.deepEqual(child.branchPoint, { kind: "event", index: 2 });
  assert.equal((await getSessionCatalogItem(root, child.id))?.parentSessionId, source.id);
  const childRecord = await readSessionCatalogRecord(root, child.id);
  assert.deepEqual(childRecord, {
    version: 1,
    sessionId: child.id,
    rootSessionId: source.id,
    parentSessionId: source.id,
    branchPoint: { kind: "event", index: 2 },
    createdAt: childRecord?.createdAt,
    updatedAt: childRecord?.updatedAt
  });

  const childRevision = (await getSessionCatalogItem(root, child.id))?.metadataRevision;
  await updateSessionCatalogMetadata(root, child.id, { title: "子会话", unread: true }, childRevision);
  const updatedChild = await getSessionCatalogItem(root, child.id);
  assert.equal(updatedChild?.title, "子会话");
  assert.equal(updatedChild?.unread, true);
  await assert.rejects(
    updateSessionCatalogMetadata(root, child.id, { archived: true }, childRevision),
    SessionCatalogConflictError
  );

  const firstPage = await querySessionCatalog(root, { limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await querySessionCatalog(root, { limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.revision, firstPage.revision);
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
  assert.equal(secondPage.nextCursor, undefined);

  const tree = buildSessionTree(catalog);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.session.id, source.id);
  assert.equal(tree[0]?.children[0]?.session.id, child.id);
  assert.equal((await readSessionTree(root))[0]?.children[0]?.session.id, child.id);
  console.log("session catalog tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
