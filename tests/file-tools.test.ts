import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyUnifiedPatch, createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { createMoveFileTool } from "../src/tools/file/moveFile.js";
import type { RunnableToolExecution, ToolExecution } from "../src/tools/types.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-tools-"));
try {
  testPatchParser();
  await testApplyPatchTool();
  await testMoveFileTool();
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

function testPatchParser(): void {
  const source = "one\ntwo\nthree\n";
  assert.equal(applyUnifiedPatch(source, "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "a.txt").content, "one\nTWO\nthree\n");
  assert.equal(applyUnifiedPatch(source, "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n", "a.txt").content, "one\nTWO\nthree\n");
  assert.equal(applyUnifiedPatch("alpha\nbeta", [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@ -1,2 +1,2 @@",
    " alpha",
    "-beta",
    "+BETA",
    "*** End Patch"
  ].join("\n"), "a.txt").content, "alpha\nBETA");
  assert.throws(() => applyUnifiedPatch(source, "@@ -1,1 +1,1 @@\n-missing\n+new\n", "a.txt"), /did not match/);
}

async function testApplyPatchTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "src.txt"), "before\nafter\n", "utf8");
  const tool = createApplyPatchTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({
    path: "src.txt",
    patch: "@@ -1,2 +1,2 @@\n-before\n+changed\n after\n"
  }));
  const result = await execution.execute({ toolCallId: "patch-1" });
  assert.deepEqual(result, { path: "src.txt", hunks: 1, changedLines: 1, bytes: Buffer.byteLength("changed\nafter\n") });
  assert.equal(await readFile(path.join(workspaceRoot, "src.txt"), "utf8"), "changed\nafter\n");
  const request = await createToolPermissionRequest({ id: "patch-preview", name: "apply_patch", args: {
    path: "src.txt", patch: "@@ -1,2 +1,2 @@\n-changed\n+again\n after\n"
  } }, { workspaceRoot, ignore: [], sessionId: "file-tools" });
  assert.equal(request.actionType, "write");
  assert.match(request.details, /Hunks: 1/);
}

async function testMoveFileTool(): Promise<void> {
  await writeFile(path.join(workspaceRoot, "from.txt"), "move me\n", "utf8");
  const tool = createMoveFileTool({ workspaceRoot, ignore: [] });
  const execution = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  await assert.rejects(execution.execute({ toolCallId: "move-missing-parent" }), /parent directory|ENOENT/i);
  await mkdir(path.join(workspaceRoot, "nested"));
  const retry = runnable(await tool.resolveExecution({ from: "from.txt", to: "nested/to.txt" }));
  assert.deepEqual(await retry.execute({ toolCallId: "move-1" }), { from: "from.txt", to: "nested/to.txt", moved: true });
  await assert.rejects(access(path.join(workspaceRoot, "from.txt")));
  assert.equal(await readFile(path.join(workspaceRoot, "nested/to.txt"), "utf8"), "move me\n");
  await writeFile(path.join(workspaceRoot, "again.txt"), "again\n", "utf8");
  const destinationExists = runnable(await tool.resolveExecution({ from: "again.txt", to: "nested/to.txt" }));
  await assert.rejects(destinationExists.execute({ toolCallId: "move-existing" }), /destination already exists/i);
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
