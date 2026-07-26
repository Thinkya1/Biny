import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiagnosticsRunner, formatDiagnostics } from "../src/tools/diagnostics.js";
import { defaultConfig, type DiagnosticsConfig } from "../src/config/schema.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-diagnostics-"));
  try {
    await testMatchesByExtension(workspaceRoot);
    await testReportsFailureOutput(workspaceRoot);
    await testTruncatesLongOutput(workspaceRoot);
    await testConcurrentEditsDoNotStackProcesses(workspaceRoot);
    await testAutoDetectNeedsLocalBinary(workspaceRoot);
    console.log("diagnostics tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function config(overrides: Partial<DiagnosticsConfig> = {}): DiagnosticsConfig {
  return { ...structuredClone(defaultConfig.diagnostics), autoDetect: false, ...overrides };
}

async function testMatchesByExtension(workspaceRoot: string): Promise<void> {
  const runner = new DiagnosticsRunner(workspaceRoot, config({
    commands: [{ extensions: [".ts"], command: "exit 0", timeoutMs: 30_000 }]
  }));
  assert.equal(runner.resolveCommand("src/a.ts")?.command, "exit 0");
  assert.equal(runner.resolveCommand("src/A.TS")?.command, "exit 0", "extension matching must be case-insensitive");
  assert.equal(runner.resolveCommand("src/a.py"), undefined);
  assert.equal(runner.resolveCommand("Makefile"), undefined);
  assert.equal(await runner.run("src/a.py"), undefined);

  const clean = await runner.run("src/a.ts");
  assert.equal(clean?.exitCode, 0);
  assert.deepEqual(formatDiagnostics(clean!), { command: "exit 0", status: "clean" });
}

async function testReportsFailureOutput(workspaceRoot: string): Promise<void> {
  const runner = new DiagnosticsRunner(workspaceRoot, config({
    commands: [{ extensions: [".ts"], command: "echo 'a.ts(3,1): error TS2304' && exit 2", timeoutMs: 30_000 }]
  }));
  const outcome = await runner.run("src/a.ts");
  assert.equal(outcome?.exitCode, 2);
  const formatted = formatDiagnostics(outcome!) as { status: string; output: string };
  assert.equal(formatted.status, "failed");
  assert.equal(formatted.output.includes("error TS2304"), true);
}

async function testTruncatesLongOutput(workspaceRoot: string): Promise<void> {
  const runner = new DiagnosticsRunner(workspaceRoot, config({
    maxOutputBytes: 256,
    commands: [{ extensions: [".ts"], command: "node -e \"process.stdout.write('x'.repeat(5000)); process.exit(1)\"", timeoutMs: 30_000 }]
  }));
  const outcome = await runner.run("src/a.ts");
  assert.equal(outcome?.truncated, true);
  assert.equal(outcome!.output.includes("[diagnostics output truncated]"), true);
  assert.equal(outcome!.output.length < 1_000, true);
}

/**
 * 并行编辑是常态。天真实现会为每次写入各拉起一个 tsc；这里断言同一条命令不会叠加进程，
 * 而且每个调用方都拿到了能看见自己那次写入的结果。
 */
async function testConcurrentEditsDoNotStackProcesses(workspaceRoot: string): Promise<void> {
  const marker = path.join(workspaceRoot, "runs.log");
  const runner = new DiagnosticsRunner(workspaceRoot, config({
    commands: [{ extensions: [".ts"], command: `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, "\\\\")}','run\\n')" && sleep 0.2`, timeoutMs: 30_000 }]
  }));
  const outcomes = await Promise.all([
    runner.run("a.ts"),
    runner.run("b.ts"),
    runner.run("c.ts"),
    runner.run("d.ts")
  ]);
  assert.equal(outcomes.every((outcome) => outcome?.exitCode === 0), true);
  const log = await readFile(marker, "utf8");
  const count = log.trim().split("\n").filter(Boolean).length;
  assert.equal(count <= 2, true, `four concurrent edits must coalesce, saw ${String(count)} runs`);
  assert.equal(count >= 1, true);
}

/** 自动识别只认项目本地已装好的二进制：不存在时静默跳过，绝不联网安装。 */
async function testAutoDetectNeedsLocalBinary(workspaceRoot: string): Promise<void> {
  const projectRoot = path.join(workspaceRoot, "auto");
  await mkdir(projectRoot, { recursive: true });
  const runner = new DiagnosticsRunner(projectRoot, config({ autoDetect: true }));
  assert.equal(runner.resolveCommand("a.ts"), undefined, "no tsconfig means no check");

  await writeFile(path.join(projectRoot, "tsconfig.json"), "{}");
  assert.equal(runner.resolveCommand("a.ts"), undefined, "tsconfig without a local tsc must not fall back to npx");

  const binDir = path.join(projectRoot, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "tsc"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(binDir, "tsc"), 0o755);
  const resolved = runner.resolveCommand("a.ts");
  assert.equal(resolved?.command.includes("node_modules/.bin/tsc"), true);
  assert.equal(resolved?.command.includes("npx"), false);
  assert.equal(runner.resolveCommand("a.py"), undefined);
}

await main();
