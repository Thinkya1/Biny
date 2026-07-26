import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { loadConfig, saveConfig } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { subagentAccessMode } from "../src/runtime/subagentAccess.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const baseRequest: PermissionRequestContext = {
  toolName: "write_file",
  actionType: "write",
  riskLevel: "medium",
  targetPath: "src/example.ts",
  sessionId: "test-session",
  projectRoot: "/workspace"
};

async function main(): Promise<void> {
  testEvaluationOrder();
  testScopedGrants();
  testSubagentAccessInheritsMode();
  await testPermissionModeWriteKeepsOtherSettings();
}

function testEvaluationOrder(): void {
  const manager = new PermissionManager({
    mode: "full-access",
    allowTools: ["write_file"],
    denyPaths: ["private/"],
    criticalAlwaysAsk: true
  });

  assert.deepEqual(
    manager.evaluate({ ...baseRequest, targetPath: "private/keys.txt" }),
    { decision: "deny", reason: "Target path is denied by project policy: private/" }
  );

  manager.setMode("read-only");
  assert.deepEqual(
    manager.evaluate(baseRequest),
    { decision: "deny", reason: "Permission mode is read only." }
  );

  manager.setMode("full-access");
  const critical = manager.evaluate({ ...baseRequest, riskLevel: "critical", targetPath: ".zshrc" });
  assert.equal(critical.decision, "ask");
  assert.match(critical.reason, /Critical operation/);

  const readOnly = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  assert.equal(readOnly.evaluate({ ...baseRequest, toolName: "read_file", actionType: "read", riskLevel: "low" }).decision, "allow");
  assert.equal(readOnly.evaluate({ ...baseRequest, toolName: "git_diff", actionType: "git", riskLevel: "low" }).decision, "allow");
  assert.equal(readOnly.evaluate(baseRequest).decision, "ask");
}

function testScopedGrants(): void {
  const manager = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  const exactCommand = {
    ...baseRequest,
    toolName: "run_command",
    actionType: "shell" as const,
    command: "pnpm typecheck",
    approvalRule: "run_command:hash-one"
  };
  manager.applyResult(exactCommand, { approved: true, scope: "command" });
  assert.equal(manager.evaluate(exactCommand).decision, "allow");
  assert.equal(manager.evaluate({ ...exactCommand, approvalRule: "run_command:hash-two", command: "pnpm test" }).decision, "ask");

  manager.applyResult(baseRequest, { approved: true, scope: "path" });
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/nested/example.ts" }).decision, "ask");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/example.ts" }).decision, "allow");

  manager.applyResult(baseRequest, { approved: true, scope: "tool" });
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "another/file.ts" }).decision, "allow");
  manager.resetSession();
  assert.equal(manager.evaluate(baseRequest).decision, "ask");
}

function testSubagentAccessInheritsMode(): void {
  const manager = new PermissionManager({ mode: "ask" });
  assert.equal(subagentAccessMode(manager), "read-only");
  manager.setMode("auto");
  assert.equal(subagentAccessMode(manager), "read-only");
  manager.setMode("full-access");
  assert.equal(subagentAccessMode(manager), "workspace");
}

/**
 * 改权限模式不能把配置文件里别处的改动写回旧值。
 *
 * 运行时内存里的 config 是创建时的快照；桌面端多个项目共用同一份配置，别的运行时切完模型后
 * 这份快照就落后了。整份写回会让「改一次权限模式，模型被切回去」。
 */
async function testPermissionModeWriteKeepsOtherSettings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-permission-config-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const onDisk = configSchema.parse({
      ...defaultConfig,
      defaultModel: "disk-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
      models: {
        "disk-model": { provider: "active", model: "disk" },
        "stale-model": { provider: "active", model: "stale" }
      },
      thinking: { enabled: false, effort: "high" },
      permission: { ...defaultConfig.permission, mode: "ask" }
    });
    await saveConfig(workspaceRoot, onDisk);

    const staleSnapshot = configSchema.parse({ ...onDisk, defaultModel: "stale-model" });
    const agent = new AgentSession({
      workspaceRoot,
      config: staleSnapshot,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(staleSnapshot.permission),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.setPermissionMode("auto");
    await agent.close();

    const persisted = await loadConfig(workspaceRoot);
    assert.equal(persisted.permission.mode, "auto");
    assert.equal(persisted.defaultModel, "disk-model");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
