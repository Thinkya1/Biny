import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CheckpointStore } from "../src/session/checkpointStore.js";
import { ensureAgentDirs } from "../src/session/store.js";

const run = promisify(execFile);

async function main(): Promise<void> {
  await testNonGitWorkspaceHasNoCheckpoints();
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-"));
  try {
    await initRepository(workspaceRoot);
    await ensureAgentDirs(workspaceRoot);
    await testRestoresEditsAndPreservesNewFiles(workspaceRoot);
    await testDoesNotTouchUserGitState(workspaceRoot);
    await testIgnoredFilesAreUntouched(workspaceRoot);
    console.log("checkpoint tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** 不是 git 仓库时能力就是不可用，不伪造一个半吊子实现。 */
async function testNonGitWorkspaceHasNoCheckpoints(): Promise<void> {
  const plain = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-plain-"));
  try {
    assert.equal(await CheckpointStore.open(plain), undefined);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
}

async function testRestoresEditsAndPreservesNewFiles(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "keep.txt"), "original\n");
  await run("git", ["add", "-A"], { cwd: workspaceRoot });
  await run("git", ["commit", "-m", "base"], { cwd: workspaceRoot });

  const store = await CheckpointStore.open(workspaceRoot);
  assert.notEqual(store, undefined);
  const checkpoint = await store!.create("before edit");

  // agent 干了两件事：改坏一个文件，又新建一个文件。
  await writeFile(path.join(workspaceRoot, "keep.txt"), "broken\n");
  await writeFile(path.join(workspaceRoot, "added.txt"), "new work\n");

  const summary = await store!.restore(checkpoint.id);
  assert.equal(await readFile(path.join(workspaceRoot, "keep.txt"), "utf8"), "original\n", "edited file must go back");
  assert.deepEqual(summary.movedAside, ["added.txt"]);
  // 新增文件被移走而不是删除：撤销本身也必须可逆。
  const trashed = path.join(workspaceRoot, summary.trashDirectory ?? "", "added.txt");
  assert.equal(await readFile(trashed, "utf8"), "new work\n");
  await assert.rejects(readFile(path.join(workspaceRoot, "added.txt"), "utf8"));

  assert.equal((await store!.list()).some((entry) => entry.id === checkpoint.id), true);
  await assert.rejects(store!.restore("does-not-exist"), /No such checkpoint/);
}

/** 建快照和恢复都不能动用户的暂存区、HEAD 和分支历史。 */
async function testDoesNotTouchUserGitState(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "staged.txt"), "staged content\n");
  await run("git", ["add", "staged.txt"], { cwd: workspaceRoot });
  const stagedBefore = (await run("git", ["diff", "--cached", "--name-only"], { cwd: workspaceRoot })).stdout.trim();
  const headBefore = (await run("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim();
  const logBefore = (await run("git", ["log", "--oneline"], { cwd: workspaceRoot })).stdout.trim();

  const store = await CheckpointStore.open(workspaceRoot);
  const checkpoint = await store!.create("with staged changes");
  await writeFile(path.join(workspaceRoot, "keep.txt"), "changed again\n");
  await store!.restore(checkpoint.id);

  assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim(), headBefore, "HEAD must not move");
  assert.equal((await run("git", ["log", "--oneline"], { cwd: workspaceRoot })).stdout.trim(), logBefore, "history must be unchanged");
  assert.equal((await run("git", ["diff", "--cached", "--name-only"], { cwd: workspaceRoot })).stdout.trim(), stagedBefore, "the staging area must be left alone");
  // 快照提交挂在 refs/biny 下，git log 看不到它们。
  const refs = (await run("git", ["for-each-ref", "--format=%(refname)", "refs/biny/checkpoints"], { cwd: workspaceRoot })).stdout;
  assert.equal(refs.includes(checkpoint.id), true);
}

/** 被 .gitignore 忽略的文件不进快照，恢复时也不该被碰。 */
async function testIgnoredFilesAreUntouched(workspaceRoot: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\n");
  await mkdir(path.join(workspaceRoot, "ignored"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "ignored", "local.txt"), "local only\n");
  await run("git", ["add", "-A"], { cwd: workspaceRoot });
  await run("git", ["commit", "-m", "gitignore"], { cwd: workspaceRoot });

  const store = await CheckpointStore.open(workspaceRoot);
  const checkpoint = await store!.create("with ignored files");
  await writeFile(path.join(workspaceRoot, "ignored", "local.txt"), "still mine\n");
  const summary = await store!.restore(checkpoint.id);

  assert.equal(await readFile(path.join(workspaceRoot, "ignored", "local.txt"), "utf8"), "still mine\n");
  assert.equal(summary.movedAside.includes("ignored/local.txt"), false);
}

async function initRepository(workspaceRoot: string): Promise<void> {
  await run("git", ["init", "-q", "-b", "main"], { cwd: workspaceRoot });
  await run("git", ["config", "user.email", "test@biny.local"], { cwd: workspaceRoot });
  await run("git", ["config", "user.name", "Biny Test"], { cwd: workspaceRoot });
  await run("git", ["config", "commit.gpgsign", "false"], { cwd: workspaceRoot });
}

await main();
