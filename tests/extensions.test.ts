import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { loadPlugins } from "../src/extensions/plugins.js";
import { loadSkills } from "../src/extensions/skills.js";
import { calculateUsageCost, summarizeUsage } from "../src/observability/usage.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-extensions-"));
  try {
    await testSkillsAndPlugins(workspaceRoot);
    await testMcpStdioTool(workspaceRoot);
    testUsageCostAccounting();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function testUsageCostAccounting(): void {
  const cost = calculateUsageCost(
    { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputPerMillionTokens: 2, outputPerMillionTokens: 4 }
  );
  assert.equal(cost.known, true);
  assert.equal(cost.costUsd, 0.004);
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
  await writeFile(path.join(workspaceRoot, "skill.md"), "Use the repository's exact test command.", "utf8");
  const skills = await loadSkills(workspaceRoot, ["skill.md"]);
  assert.deepEqual(skills.paths, ["skill.md"]);
  assert.match(skills.prompt, /exact test command/);

  const pluginPath = path.join(workspaceRoot, "plugin.mjs");
  await writeFile(pluginPath, `export default ({ registerTool }) => registerTool({
    name: "plugin_echo",
    description: "Echo from a plugin",
    parameters: { type: "object" },
    schema: { parse: (value) => value },
    resolveExecution: () => ({ approvalRule: "plugin_echo", execute: async () => "plugin ok" })
  });\n`, "utf8");
  const registry = new ToolRegistry();
  const config = configSchema.parse(defaultConfig);
  const loaded = await loadPlugins(workspaceRoot, ["plugin.mjs"], config, registry);
  assert.deepEqual(loaded, ["plugin.mjs"]);
  assert.equal(registry.listEntries()[0]?.source, "plugin");
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
}

await main();
