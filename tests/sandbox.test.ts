import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSeatbeltProfile, describeSandbox, sandboxCommand } from "../src/tools/shell/sandbox.js";
import { runShellCommand } from "../src/tools/shell/runCommand.js";

async function main(): Promise<void> {
  testOffAndUnsupportedPlatformsAreHonest();
  testProfileShape();
  await testRealBoundaryOnMacOs();
  console.log("sandbox tests passed");
}

/** 沙箱没生效时必须说出来，不能让"沙箱模式"这个名字暗示一个不存在的保护。 */
function testOffAndUnsupportedPlatformsAreHonest(): void {
  const environment = { platform: "darwin" as NodeJS.Platform, home: "/Users/x", temporaryDirectory: "/tmp" };
  const off = sandboxCommand("echo hi", "/ws", { mode: "off", allowNetwork: true }, environment);
  assert.equal(off.applied, false);
  assert.equal(off.command, "echo hi");
  assert.equal(typeof off.reason, "string");

  const linux = sandboxCommand("echo hi", "/ws", { mode: "workspace-write", allowNetwork: true }, { ...environment, platform: "linux" });
  assert.equal(linux.applied, false);
  assert.equal(linux.command, "echo hi", "an unavailable sandbox must not silently alter the command");
  assert.equal(/linux/.test(linux.reason ?? ""), true);
  assert.equal(describeSandbox({ mode: "workspace-write", allowNetwork: true }, "linux"), "requested but unavailable on linux");
  assert.equal(describeSandbox({ mode: "workspace-write", allowNetwork: false }, "darwin"), "workspace-write, no network");
}

function testProfileShape(): void {
  const profile = buildSeatbeltProfile("/ws", { mode: "workspace-write", allowNetwork: false }, { home: "/Users/x", temporaryDirectory: "/tmp" });
  assert.equal(profile.includes("(deny file-write*)"), true);
  assert.equal(profile.includes('(subpath "/ws")'), true);
  assert.equal(profile.includes("(deny network*)"), true);
  const networked = buildSeatbeltProfile("/ws", { mode: "workspace-write", allowNetwork: true }, { home: "/Users/x", temporaryDirectory: "/tmp" });
  assert.equal(networked.includes("(deny network*)"), false);
}

/**
 * 真正跑一次。前面那些断言只证明字符串拼对了，证明不了内核真的挡住了写入 —— 而这正是这
 * 个功能唯一的价值所在。
 */
async function testRealBoundaryOnMacOs(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("sandbox boundary check skipped: not macOS");
    return;
  }
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-sandbox-ws-"));
  // 必须建在临时目录之外：临时目录本身在白名单里（构建工具需要），拿它当"外部"验证不到东西。
  const outside = await mkdtemp(path.join(os.homedir(), ".biny-sandbox-outside-"));
  try {
    await writeFile(path.join(outside, "victim.txt"), "original\n");
    const options = { mode: "workspace-write" as const, allowNetwork: true };
    const environment = { platform: process.platform, home: os.homedir(), temporaryDirectory: os.tmpdir() };

    const allowed = sandboxCommand("echo written > inside.txt", workspaceRoot, options, environment);
    assert.equal(allowed.applied, true);
    const allowedRun = await runShellCommand(workspaceRoot, allowed.command, { timeoutMs: 30_000 });
    assert.equal(allowedRun.exitCode, 0, `writing inside the workspace must work: ${allowedRun.stderr}`);
    assert.equal((await readFile(path.join(workspaceRoot, "inside.txt"), "utf8")).trim(), "written");

    // 关键断言：工作区之外的写入必须被内核拒绝，而不是被某条正则拦下。
    const victim = path.join(outside, "victim.txt");
    const denied = sandboxCommand(`echo pwned > ${JSON.stringify(victim)}`, workspaceRoot, options, environment);
    const deniedRun = await runShellCommand(workspaceRoot, denied.command, { timeoutMs: 30_000 });
    assert.notEqual(deniedRun.exitCode, 0, "writing outside the workspace must fail");
    assert.equal(await readFile(victim, "utf8"), "original\n", "the file outside the workspace must be untouched");

    // 判定绕过也一样挡住：这正是正则做不到的部分。
    const obfuscated = sandboxCommand(
      `sh -c "$(echo 'ZWNobyBwd25lZCA+ICcnJHtWSUNUSU19JycK' | base64 --decode)"`,
      workspaceRoot,
      options,
      { ...environment }
    );
    const obfuscatedRun = await runShellCommand(workspaceRoot, obfuscated.command, {
      timeoutMs: 30_000
    });
    assert.equal(await readFile(victim, "utf8"), "original\n", `an obfuscated write must also be blocked (exit ${String(obfuscatedRun.exitCode)})`);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

await main();
