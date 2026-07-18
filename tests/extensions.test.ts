import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { loadPlugins } from "../src/extensions/plugins.js";
import { loadSkills } from "../src/extensions/skills.js";
import { calculateUsageCost, summarizeUsage } from "../src/observability/usage.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-extensions-"));
  try {
    await testSkillsAndPlugins(workspaceRoot);
    await testExtensionPathBoundary(workspaceRoot);
    await testMcpStdioTool(workspaceRoot);
    testUsageCostAccounting();
    testShellPermissionBoundary();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function testShellPermissionBoundary(): void {
  const request = analyzePermissionRequest({
    toolName: "run_command",
    args: { command: "git status && node -e 'process.exit(0)'" },
    sessionId: "test",
    projectRoot: "/workspace"
  });
  assert.equal(request.actionType, "shell");
  assert.equal(request.riskLevel, "medium");
  assert.equal(new PermissionManager().evaluate(request).decision, "ask");

  const builtinInspection = analyzePermissionRequest({
    toolName: "git_status",
    args: {},
    sessionId: "test",
    projectRoot: "/workspace"
  });
  assert.equal(builtinInspection.actionType, "git");
  assert.equal(builtinInspection.riskLevel, "low");
  assert.equal(new PermissionManager().evaluate(builtinInspection).decision, "allow");

  const criticalWrite = analyzePermissionRequest({
    toolName: "write_file",
    args: { path: "temporary/../.zshrc", content: "not-used" },
    sessionId: "test",
    projectRoot: "/workspace"
  });
  assert.equal(criticalWrite.targetPath, ".zshrc");
  assert.equal(criticalWrite.riskLevel, "critical");

  const deniedRead = analyzePermissionRequest({
    toolName: "read_file",
    args: { path: "temporary/../private/token.txt" },
    sessionId: "test",
    projectRoot: "/workspace"
  });
  assert.equal(new PermissionManager({ denyPaths: ["private/"] }).evaluate(deniedRead).decision, "deny");
}

function testUsageCostAccounting(): void {
  const cost = calculateUsageCost(
    { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputPerMillionTokens: 2, outputPerMillionTokens: 4 }
  );
  assert.equal(cost.known, true);
  assert.equal(cost.costUsd, 0.004);
  const cachedCost = calculateUsageCost(
    { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 200, cacheWriteTokens: 100 },
    {
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 4,
      cacheReadPerMillionTokens: 0.5,
      cacheWritePerMillionTokens: 2.5
    }
  );
  assert.equal(cachedCost.known, true);
  assert.equal(cachedCost.costUsd, 0.00175);
  const summary = summarizeUsage([{
    operation: "agent",
    modelAlias: "test",
    provider: "test",
    model: "test",
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    pricingKnown: true,
    costUsd: cost.costUsd
  }]);
  assert.equal(summary.pricingKnown, true);
  assert.equal(summary.costUsd, 0.004);
}

async function testSkillsAndPlugins(workspaceRoot: string): Promise<void> {
  const extensionDefaults = configSchema.parse({ ...defaultConfig, extensions: {} }).extensions;
  assert.deepEqual(extensionDefaults.skills, [".agent/skills"]);
  assert.deepEqual(extensionDefaults.plugins, []);
  assert.throws(
    () => configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, plugins: [" "] } }),
    /at least 1 character/
  );

  await writeFile(path.join(workspaceRoot, "skill.md"), "Use the repository's exact test command.", "utf8");
  const skills = await loadSkills(workspaceRoot, ["skill.md", "./skill.md"]);
  assert.deepEqual(skills.paths, ["skill.md"]);
  assert.match(skills.prompt, /exact test command/);

  const pluginPath = path.join(workspaceRoot, "plugin.mjs");
  await writeFile(pluginPath, `export default ({ config, registerTool }) => registerTool({
    name: "plugin_secret_probe",
    description: "Verify the plugin context excludes credentials",
    parameters: { type: "object" },
    schema: { parse: (value) => value },
    resolveExecution: () => ({
      approvalRule: "plugin_secret_probe",
      execute: async () => ({
        providerApiKey: config.providers.deepseek.apiKey,
        mcpEnv: config.extensions.mcp.secret?.env
      })
    })
  });\n`, "utf8");
  const registry = new ToolRegistry();
  const config = configSchema.parse({
    ...defaultConfig,
    providers: {
      ...defaultConfig.providers,
      deepseek: { ...defaultConfig.providers.deepseek, apiKey: "test-only-api-key" }
    },
    extensions: {
      ...defaultConfig.extensions,
      mcp: {
        secret: {
          command: process.execPath,
          env: { TEST_ONLY_TOKEN: "test-only-mcp-token" }
        }
      }
    }
  });
  const loaded = await loadPlugins(workspaceRoot, ["plugin.mjs", "./plugin.mjs"], config, registry);
  assert.deepEqual(loaded, ["plugin.mjs"]);
  assert.equal(registry.listEntries()[0]?.source, "plugin");
  const execution = await registry.get("plugin_secret_probe").resolveExecution({});
  assert.equal("isError" in execution, false);
  if (!("isError" in execution)) {
    assert.deepEqual(await execution.execute({ toolCallId: "test" }), {
      providerApiKey: undefined,
      mcpEnv: undefined
    });
  }
  assert.equal(config.providers.deepseek?.apiKey, "test-only-api-key");
  assert.deepEqual(config.extensions.mcp.secret?.env, { TEST_ONLY_TOKEN: "test-only-mcp-token" });

  const commonJsPath = path.join(workspaceRoot, "plugin.cjs");
  await writeFile(commonJsPath, `module.exports = {
    register({ registerTool }) {
      registerTool({
        name: "plugin_commonjs",
        description: "CommonJS plugin",
        parameters: { type: "object" },
        schema: { parse: (value) => value },
        resolveExecution: () => ({ approvalRule: "plugin_commonjs", execute: async () => "commonjs ok" })
      });
    }
  };\n`, "utf8");
  assert.deepEqual(await loadPlugins(workspaceRoot, ["plugin.cjs"], config, registry), ["plugin.cjs"]);
  const commonJsExecution = await registry.get("plugin_commonjs").resolveExecution({});
  assert.equal("isError" in commonJsExecution, false);
  if (!("isError" in commonJsExecution)) {
    assert.equal(await commonJsExecution.execute({ toolCallId: "test" }), "commonjs ok");
  }
}

async function testExtensionPathBoundary(workspaceRoot: string): Promise<void> {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-external-extension-"));
  try {
    const externalSkill = path.join(externalRoot, "skill.md");
    const externalPlugin = path.join(externalRoot, "plugin.mjs");
    await writeFile(externalSkill, "External skill must not load.", "utf8");
    await writeFile(externalPlugin, "export default () => {};\n", "utf8");

    const skillSymlink = path.join(workspaceRoot, "skill-link.md");
    const pluginSymlink = path.join(workspaceRoot, "plugin-link.mjs");
    await symlink(externalSkill, skillSymlink);
    await symlink(externalPlugin, pluginSymlink);
    await assert.rejects(loadSkills(workspaceRoot, ["skill-link.md"]), /symbolic link/);
    await assert.rejects(
      loadPlugins(workspaceRoot, ["plugin-link.mjs"], configSchema.parse(defaultConfig), new ToolRegistry()),
      /symbolic link/
    );

    const skillHardlink = path.join(workspaceRoot, "skill-hardlink.md");
    const pluginHardlink = path.join(workspaceRoot, "plugin-hardlink.mjs");
    await link(externalSkill, skillHardlink);
    await link(externalPlugin, pluginHardlink);
    await assert.rejects(loadSkills(workspaceRoot, ["skill-hardlink.md"]), /hardlinks/);
    await assert.rejects(
      loadPlugins(workspaceRoot, ["plugin-hardlink.mjs"], configSchema.parse(defaultConfig), new ToolRegistry()),
      /hardlinks/
    );

    const racedSkill = path.join(workspaceRoot, "skill-race.md");
    await writeFile(racedSkill, "Safe skill before the read boundary.", "utf8");
    const probeHandle = await fs.open(racedSkill, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      read: (this: typeof probeHandle, ...args: Parameters<typeof probeHandle.read>) => ReturnType<typeof probeHandle.read>;
    };
    const originalRead = fileHandlePrototype.read;
    await probeHandle.close();
    let replacedDuringRead = false;
    fileHandlePrototype.read = (async function (this: typeof probeHandle, ...args: Parameters<typeof probeHandle.read>) {
      if (!replacedDuringRead) {
        replacedDuringRead = true;
        await fs.rm(racedSkill);
        await fs.symlink(externalSkill, racedSkill);
      }
      return await originalRead.apply(this, args);
    }) as typeof fileHandlePrototype.read;
    try {
      const raced = await loadSkills(workspaceRoot, ["skill-race.md"]);
      assert.equal(replacedDuringRead, true);
      assert.equal(raced.prompt.includes("External skill must not load."), false);
      assert.deepEqual(raced.paths, []);
    } finally {
      fileHandlePrototype.read = originalRead;
      await fs.rm(racedSkill, { force: true });
    }

    const traversal = path.relative(workspaceRoot, externalSkill);
    await assert.rejects(loadSkills(workspaceRoot, [traversal]), /must stay inside workspace/);
    await assert.rejects(
      loadPlugins(workspaceRoot, [traversal], configSchema.parse(defaultConfig), new ToolRegistry()),
      /must stay inside workspace/
    );

    const realDirectory = path.join(workspaceRoot, "real-extensions");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "nested-skill.md"), "Nested skill", "utf8");
    await writeFile(path.join(realDirectory, "nested-plugin.mjs"), "export default () => {};\n", "utf8");
    await symlink(realDirectory, path.join(workspaceRoot, "extension-alias"));
    await assert.rejects(loadSkills(workspaceRoot, ["extension-alias/nested-skill.md"]), /symbolic links/);
    await assert.rejects(
      loadPlugins(
        workspaceRoot,
        ["extension-alias/nested-plugin.mjs"],
        configSchema.parse(defaultConfig),
        new ToolRegistry()
      ),
      /symbolic links/
    );

    const workspaceAlias = path.join(externalRoot, "workspace-alias");
    await symlink(workspaceRoot, workspaceAlias);
    assert.deepEqual((await loadSkills(workspaceAlias, ["skill.md"])).paths, ["skill.md"]);
    assert.deepEqual(
      await loadPlugins(workspaceAlias, ["plugin.mjs"], configSchema.parse(defaultConfig), new ToolRegistry()),
      ["plugin.mjs"]
    );
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
}

async function testMcpStdioTool(workspaceRoot: string): Promise<void> {
  const serverPath = path.join(workspaceRoot, "mcp-server.mjs");
  await writeFile(serverPath, `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: request.params.arguments.value }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});\n`, "utf8");

  const config = configSchema.parse({
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      mcp: { demo: { command: process.execPath, args: [serverPath], cwd: ".", stderr: "ignore", enabled: true } }
    }
  });
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(workspaceRoot, config, registry);
    assert.deepEqual(host.listServers(), [{
      name: "demo",
      command: process.execPath,
      enabled: true,
      connected: true,
      toolNames: ["mcp_demo_echo"]
    }]);
    const entry = registry.listEntries()[0];
    assert.equal(entry?.source, "mcp");
    const execution = await registry.get("mcp_demo_echo").resolveExecution({ value: "hello" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    assert.equal(await execution.execute({ toolCallId: "test", signal: undefined }), "hello");
  } finally {
    await host.close();
  }

  const externalCwd = await mkdtemp(path.join(os.tmpdir(), "biny-external-mcp-cwd-"));
  try {
    await symlink(externalCwd, path.join(workspaceRoot, "mcp-cwd-link"));
    const unsafeConfig = configSchema.parse({
      ...defaultConfig,
      extensions: {
        ...defaultConfig.extensions,
        mcp: {
          demo: {
            command: process.execPath,
            args: [serverPath],
            cwd: "mcp-cwd-link",
            stderr: "ignore",
            enabled: true
          }
        }
      }
    });
    const unsafeHost = new McpToolHost();
    await assert.rejects(
      unsafeHost.connectConfiguredServers(workspaceRoot, unsafeConfig, new ToolRegistry()),
      /MCP cwd cannot be a symbolic link/
    );
    await unsafeHost.close();
  } finally {
    await rm(externalCwd, { recursive: true, force: true });
  }
}

await main();
