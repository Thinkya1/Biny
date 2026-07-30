import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createMcpResourceTools, expandEnvTemplate, McpToolHost } from "../src/extensions/mcp.js";
import { loadPlugins } from "../src/extensions/plugins.js";
import { createSkillTool, loadSkills } from "../src/extensions/skills.js";
import { calculateUsageCost, summarizeUsage } from "../src/observability/usage.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
  assert.deepEqual(extensionDefaults.skills, [".biny/skills"]);
  assert.deepEqual(extensionDefaults.plugins, []);
  assert.throws(
    () => configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, plugins: [" "] } }),
    /at least 1 character/
  );
  assert.throws(
    () => configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { remote: { type: "http" } } } }),
    /http MCP server requires a url/
  );
  const httpServer = configSchema.parse({
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: { remote: { url: "https://example.com/mcp" } } }
  }).extensions.mcp.remote;
  assert.equal(httpServer?.url, "https://example.com/mcp");

  await testProgressiveSkills(workspaceRoot);

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
        mcpEnv: config.extensions.mcp.secret?.env,
        mcpHeaders: config.extensions.mcp.remote?.headers
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
        },
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer test-only-http-token" }
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
      mcpEnv: undefined,
      mcpHeaders: undefined
    });
  }
  assert.equal(config.providers.deepseek?.apiKey, "test-only-api-key");
  assert.deepEqual(config.extensions.mcp.secret?.env, { TEST_ONLY_TOKEN: "test-only-mcp-token" });
  assert.deepEqual(config.extensions.mcp.remote?.headers, { Authorization: "Bearer test-only-http-token" });

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

async function testProgressiveSkills(workspaceRoot: string): Promise<void> {
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-skills-"));
  try {
    const projectSkillDir = path.join(workspaceRoot, ".biny", "skills", "test-runner");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(path.join(projectSkillDir, "SKILL.md"), [
      "---",
      "name: test-runner",
      "description: Run the repository test suite the right way",
      "---",
      "",
      "# Test runner",
      "",
      "Always run pnpm test from the workspace root."
    ].join("\n"), "utf8");
    await writeFile(path.join(projectSkillDir, "notes.md"), "Extra notes bundled with the skill.", "utf8");

    // 与项目技能同名的全局技能应被项目级覆盖；另一个全局技能正常加载。
    const globalOverride = path.join(globalRoot, "test-runner");
    const globalOnly = path.join(globalRoot, "release-notes");
    await mkdir(globalOverride, { recursive: true });
    await mkdir(globalOnly, { recursive: true });
    await writeFile(path.join(globalOverride, "SKILL.md"), "---\nname: test-runner\ndescription: Global variant must lose\n---\nGlobal body.", "utf8");
    await writeFile(path.join(globalOnly, "SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes from git history\n---\nGlobal release instructions.", "utf8");

    const bundle = await loadSkills({ workspaceRoot, projectPaths: [".biny/skills"], globalRoot });
    assert.deepEqual(bundle.skills.map((skill) => [skill.name, skill.scope]), [
      ["test-runner", "project"],
      ["release-notes", "global"]
    ]);
    // 渐进式披露：prompt 只含元数据与 invoke_skill 指引，不含技能正文。
    assert.match(bundle.prompt, /test-runner \(project\): Run the repository test suite/);
    assert.match(bundle.prompt, /release-notes \(global\): Draft release notes/);
    assert.match(bundle.prompt, /invoke_skill/);
    assert.equal(bundle.prompt.includes("Always run pnpm test"), false);
    assert.equal(bundle.prompt.includes("Global variant must lose"), false);

    const tool = createSkillTool(bundle);
    assert.equal(tool.name, "invoke_skill");
    assert.equal(tool.risk, "read");
    const execution = await tool.resolveExecution({ skill: "test-runner" });
    assert.equal("isError" in execution, false);
    if (!("isError" in execution)) {
      const result = await execution.execute({ toolCallId: "test" }) as { skill: string; scope: string; instructions: string; files: string[] };
      assert.equal(result.skill, "test-runner");
      assert.equal(result.scope, "project");
      assert.match(result.instructions, /Always run pnpm test/);
      assert.deepEqual(result.files, ["notes.md"]);
    }
    const globalExecution = await tool.resolveExecution({ skill: "release-notes" });
    assert.equal("isError" in globalExecution, false);
    if (!("isError" in globalExecution)) {
      const result = await globalExecution.execute({ toolCallId: "test" }) as { instructions: string; scope: string };
      assert.equal(result.scope, "global");
      assert.match(result.instructions, /Global release instructions/);
    }
    const unknown = await tool.resolveExecution({ skill: "missing" });
    assert.equal("isError" in unknown && unknown.isError, true);
    if ("isError" in unknown) assert.match(unknown.errorMessage, /Unknown skill: missing/);

    // 裸 .md 技能保持兼容：文件名主干作为名称，首行作为描述。
    await writeFile(path.join(workspaceRoot, "legacy-skill.md"), "Use the repository's exact test command.", "utf8");
    const legacy = await loadSkills({ workspaceRoot, projectPaths: ["legacy-skill.md", "./legacy-skill.md"], globalRoot: path.join(workspaceRoot, "no-global") });
    assert.deepEqual(legacy.paths, ["legacy-skill.md"]);
    assert.deepEqual(legacy.skills.map((skill) => skill.name), ["legacy-skill"]);
    assert.match(legacy.prompt, /exact test command/);

    // 以水平分割线开头的正文不应被误判成 frontmatter 丢内容。
    await writeFile(path.join(workspaceRoot, "hr-skill.md"), "---\n\n# Title\n\nStep one: build.\n\n---\n\nMore notes.", "utf8");
    const horizontalRule = await loadSkills({
      workspaceRoot,
      projectPaths: ["hr-skill.md"],
      globalRoot: path.join(workspaceRoot, "no-global")
    });
    assert.equal(horizontalRule.skills[0]?.description, "Step one: build.");

    // 全局目录里的符号链接只导致放弃全局技能，不能阻断加载/启动。
    const poisonedGlobal = await mkdtemp(path.join(os.tmpdir(), "biny-global-poison-"));
    try {
      const poisonTarget = path.join(poisonedGlobal, "real-dir");
      await mkdir(poisonTarget);
      await symlink(poisonTarget, path.join(poisonedGlobal, "aaa-link"));
      const degraded = await loadSkills({ workspaceRoot, projectPaths: [".biny/skills"], globalRoot: poisonedGlobal });
      assert.equal(degraded.skills.some((skill) => skill.scope === "global"), false);
      assert.equal(degraded.skills.some((skill) => skill.name === "test-runner"), true);
    } finally {
      await rm(poisonedGlobal, { recursive: true, force: true });
    }
  } finally {
    await rm(globalRoot, { recursive: true, force: true });
    await rm(path.join(workspaceRoot, ".biny"), { recursive: true, force: true });
    await rm(path.join(workspaceRoot, "legacy-skill.md"), { force: true });
    await rm(path.join(workspaceRoot, "hr-skill.md"), { force: true });
  }
}

async function testExtensionPathBoundary(workspaceRoot: string): Promise<void> {
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-external-extension-"));
  // 边界测试固定使用一个不存在的全局技能目录，避免受本机 ~/.biny/skills 影响。
  const noGlobal = path.join(workspaceRoot, "no-global-skills");
  const loadWorkspaceSkills = async (root: string, projectPaths: string[]) => await loadSkills({ workspaceRoot: root, projectPaths, globalRoot: noGlobal });
  try {
    const externalSkill = path.join(externalRoot, "skill.md");
    const externalPlugin = path.join(externalRoot, "plugin.mjs");
    await writeFile(externalSkill, "External skill must not load.", "utf8");
    await writeFile(externalPlugin, "export default () => {};\n", "utf8");

    const skillSymlink = path.join(workspaceRoot, "skill-link.md");
    const pluginSymlink = path.join(workspaceRoot, "plugin-link.mjs");
    await symlink(externalSkill, skillSymlink);
    await symlink(externalPlugin, pluginSymlink);
    await assert.rejects(loadWorkspaceSkills(workspaceRoot, ["skill-link.md"]), /symbolic link/);
    await assert.rejects(
      loadPlugins(workspaceRoot, ["plugin-link.mjs"], configSchema.parse(defaultConfig), new ToolRegistry()),
      /symbolic link/
    );

    const skillHardlink = path.join(workspaceRoot, "skill-hardlink.md");
    const pluginHardlink = path.join(workspaceRoot, "plugin-hardlink.mjs");
    await link(externalSkill, skillHardlink);
    await link(externalPlugin, pluginHardlink);
    await assert.rejects(loadWorkspaceSkills(workspaceRoot, ["skill-hardlink.md"]), /hardlinks/);
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
      const raced = await loadWorkspaceSkills(workspaceRoot, ["skill-race.md"]);
      assert.equal(replacedDuringRead, true);
      assert.equal(raced.prompt.includes("External skill must not load."), false);
      assert.deepEqual(raced.paths, []);
    } finally {
      fileHandlePrototype.read = originalRead;
      await fs.rm(racedSkill, { force: true });
    }

    const traversal = path.relative(workspaceRoot, externalSkill);
    await assert.rejects(loadWorkspaceSkills(workspaceRoot, [traversal]), /must stay inside workspace/);
    await assert.rejects(
      loadPlugins(workspaceRoot, [traversal], configSchema.parse(defaultConfig), new ToolRegistry()),
      /must stay inside workspace/
    );

    const realDirectory = path.join(workspaceRoot, "real-extensions");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "nested-skill.md"), "Nested skill", "utf8");
    await writeFile(path.join(realDirectory, "nested-plugin.mjs"), "export default () => {};\n", "utf8");
    await symlink(realDirectory, path.join(workspaceRoot, "extension-alias"));
    await assert.rejects(loadWorkspaceSkills(workspaceRoot, ["extension-alias/nested-skill.md"]), /symbolic links/);
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
    await writeFile(path.join(workspaceRoot, "skill.md"), "Alias-reachable skill.", "utf8");
    assert.deepEqual((await loadWorkspaceSkills(workspaceAlias, ["skill.md"])).paths, ["skill.md"]);
    assert.deepEqual(
      await loadPlugins(workspaceAlias, ["plugin.mjs"], configSchema.parse(defaultConfig), new ToolRegistry()),
      ["plugin.mjs"]
    );
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
}

async function testMcpStdioTool(workspaceRoot: string): Promise<void> {
  // ${ENV} 展开：命中、默认值、缺失报错。
  process.env.BINY_TEST_MCP_VAR = "expanded";
  assert.equal(expandEnvTemplate("--token=${BINY_TEST_MCP_VAR}"), "--token=expanded");
  assert.equal(expandEnvTemplate("${BINY_TEST_MISSING:-fallback}"), "fallback");
  assert.throws(() => expandEnvTemplate("${BINY_TEST_MISSING}"), /is not set/);
  delete process.env.BINY_TEST_MCP_VAR;

  const serverPath = path.join(workspaceRoot, "mcp-server.mjs");
  await writeFile(serverPath, `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let extraTool = false;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: "test", version: "1" },
      instructions: "Use the echo tool for demo purposes."
    };
  } else if (request.method === "tools/list") {
    const tools = [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
    if (extraTool) tools.push({ name: "extra", description: "Added later", inputSchema: { type: "object" } });
    result = { tools };
  } else if (request.method === "tools/call") {
    const value = request.params.arguments?.value ?? "";
    if (value === "__grow__") {
      extraTool = true;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    if (value === "__die__") {
      write({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "dying" }] } });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    result = { content: [{ type: "text", text: value }] };
  } else if (request.method === "resources/list") {
    result = { resources: [{ uri: "demo://readme", name: "readme", mimeType: "text/plain" }] };
  } else if (request.method === "resources/read") {
    result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "resource body" }] };
  } else if (request.method === "prompts/list") {
    result = { prompts: [{ name: "review" }] };
  } else result = {};
  write({ jsonrpc: "2.0", id: request.id, result });
});\n`, "utf8");

  const config = configSchema.parse({
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      mcp: { demo: { command: process.execPath, args: [serverPath], cwd: ".", stderr: "ignore", enabled: true, timeoutMs: 10_000 } }
    }
  });
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(workspaceRoot, config, registry);
    const status = host.listServers()[0];
    assert.equal(status?.name, "demo");
    assert.equal(status?.transport, "stdio");
    assert.equal(status?.connected, true);
    assert.deepEqual(status?.toolNames, ["mcp_demo_echo"]);
    assert.deepEqual(status?.promptNames, ["review"]);
    assert.equal(status?.hasResources, true);
    assert.equal(status?.instructions, "Use the echo tool for demo purposes.");
    assert.match(host.instructionsPrompt(), /Instructions from MCP server demo/);

    const entry = registry.listEntries()[0];
    assert.equal(entry?.source, "mcp");
    const callEcho = async (value: string): Promise<unknown> => {
      const execution = await registry.get("mcp_demo_echo").resolveExecution({ value });
      assert.equal("isError" in execution, false);
      if ("isError" in execution) throw new Error("unexpected tool error");
      return await execution.execute({ toolCallId: "test", signal: undefined });
    };
    assert.equal(await callEcho("hello"), "hello");

    // resources 通用工具。
    const [listResources, readResource] = createMcpResourceTools(host);
    const listExecution = await listResources!.resolveExecution({});
    assert.equal("isError" in listExecution, false);
    if (!("isError" in listExecution)) {
      assert.deepEqual(await listExecution.execute({ toolCallId: "test" }), [
        { server: "demo", uri: "demo://readme", name: "readme", description: undefined, mimeType: "text/plain" }
      ]);
    }
    const readExecution = await readResource!.resolveExecution({ server: "demo", uri: "demo://readme" });
    assert.equal("isError" in readExecution, false);
    if (!("isError" in readExecution)) {
      assert.deepEqual(await readExecution.execute({ toolCallId: "test" }), {
        server: "demo",
        uri: "demo://readme",
        contents: [{ uri: "demo://readme", mimeType: "text/plain", text: "resource body" }]
      });
    }

    // tools/list_changed 动态刷新。
    assert.equal(await callEcho("__grow__"), "__grow__");
    await waitFor(() => host.listServers()[0]?.toolNames.includes("mcp_demo_extra") ?? false);
    // 原子替换必须保留完整新集合，不留下重名跳过告警。
    assert.deepEqual(host.listServers()[0]?.toolNames, ["mcp_demo_echo", "mcp_demo_extra"]);
    assert.equal(host.listServers()[0]?.lastError, undefined);
    assert.deepEqual(registry.listEntries().map((item) => item.tool.name), ["mcp_demo_echo", "mcp_demo_extra"]);

    // 服务器退出后：状态置为断开，下一次调用触发懒重连（重启子进程）。
    assert.equal(await callEcho("__die__"), "dying");
    await waitFor(() => host.listServers()[0]?.connected === false);
    assert.equal(await callEcho("revived"), "revived");
    assert.equal(host.listServers()[0]?.connected, true);
    // 重连到新进程后也应整体替换，不能残留旧进程声明的 extra 工具。
    assert.deepEqual(host.listServers()[0]?.toolNames, ["mcp_demo_echo"]);
    assert.deepEqual(registry.listEntries().map((item) => item.tool.name), ["mcp_demo_echo"]);
  } finally {
    await host.close();
  }

  // 即使资源工具可用，显式指定 disabled server 也不能让它被懒连接拉起。
  const disabledConfig = configSchema.parse({
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      mcp: {
        demo: { command: process.execPath, args: [serverPath], cwd: ".", stderr: "ignore", enabled: true },
        disabled: { command: process.execPath, args: [serverPath, "${BINY_TEST_DISABLED_TOKEN}"], cwd: ".", stderr: "ignore", enabled: false }
      }
    }
  });
  const disabledHost = new McpToolHost();
  try {
    await disabledHost.connectConfiguredServers(workspaceRoot, disabledConfig, new ToolRegistry());
    assert.equal(disabledHost.listServers().find((server) => server.name === "disabled")?.connected, false);
    const [listResources, readResource] = createMcpResourceTools(disabledHost);
    const listExecution = await listResources!.resolveExecution({ server: "disabled" });
    assert.equal("isError" in listExecution, false);
    if (!("isError" in listExecution)) {
      await assert.rejects(listExecution.execute({ toolCallId: "test" }), /disabled in agent\.config\.json/);
    }
    const readExecution = await readResource!.resolveExecution({ server: "disabled", uri: "demo://readme" });
    assert.equal("isError" in readExecution, false);
    if (!("isError" in readExecution)) {
      await assert.rejects(readExecution.execute({ toolCallId: "test" }), /disabled in agent\.config\.json/);
    }
    assert.equal(disabledHost.listServers().find((server) => server.name === "disabled")?.connected, false);
  } finally {
    await disabledHost.close();
  }

  // 变量缺失时失败；补齐环境变量后重连要重新展开原始配置并成功。
  const envName = "BINY_TEST_RECONNECT_TOKEN";
  delete process.env[envName];
  const envConfig = configSchema.parse({
    ...defaultConfig,
    extensions: {
      ...defaultConfig.extensions,
      mcp: { pending: { command: process.execPath, args: [serverPath, `\${${envName}}`], cwd: ".", stderr: "ignore", enabled: true } }
    }
  });
  const envHost = new McpToolHost();
  try {
    await envHost.connectConfiguredServers(workspaceRoot, envConfig, new ToolRegistry());
    assert.match(envHost.listServers()[0]?.lastError ?? "", new RegExp(`Environment variable ${envName} is not set`));
    process.env[envName] = "now-present";
    const status = await envHost.reconnectServer("pending");
    assert.equal(status.connected, true);
  } finally {
    delete process.env[envName];
    await envHost.close();
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
    // 单服务器失败被隔离：不再抛出，只在状态上记录错误。
    const unsafeHost = new McpToolHost();
    await unsafeHost.connectConfiguredServers(workspaceRoot, unsafeConfig, new ToolRegistry());
    const unsafeStatus = unsafeHost.listServers()[0];
    assert.equal(unsafeStatus?.connected, false);
    assert.match(unsafeStatus?.lastError ?? "", /MCP cwd cannot be a symbolic link/);
    await unsafeHost.close();
  } finally {
    await rm(externalCwd, { recursive: true, force: true });
  }
}

await main();
