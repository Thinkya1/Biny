import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, ToolExecutionOptions } from "ai";
import { z } from "zod";
import { SdkToolExecutionCoordinator } from "../src/agent/sdkToolExecutionCoordinator.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";
import type { Tool } from "../src/tools/types.js";

interface ExecutableTool {
  execute(input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown>;
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-result-archive-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig) as AgentConfig;
    config.context.maxTurnToolResultBytes = 1_024;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(largeResultTool());
    registry.register(createReadToolResultTool({ workspaceRoot, ignore: config.workspace.ignore }));
    const recorder = new SessionRecorder(workspaceRoot, "archive-test");
    const coordinator = new SdkToolExecutionCoordinator({
      workspaceRoot,
      config,
      model: {} as LanguageModel,
      recorder,
      toolRegistry: registry
    }, new PermissionManager(config.permission), () => undefined);
    const tool = coordinator.createTools().large_result as unknown as ExecutableTool;

    const first = await tool.execute({}, toolOptions("first"));
    const second = await tool.execute({}, toolOptions("second")) as Record<string, unknown>;
    assert.equal(typeof first, "object");
    assert.equal(second.archived, true);
    assert.equal(Number(second.resultBytes) > 768, true);
    assert.equal(typeof second.preview, "string");
    assert.equal(typeof second.archivePath, "string");

    const archivePath = path.join(workspaceRoot, String(second.archivePath));
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as { output?: string };
    const originalResult = JSON.parse(archive.output ?? "{}") as { result?: string };
    assert.equal(originalResult.result, "x".repeat(768));

    // 归档目录被 workspace ignore 挡在 read_file 之外，模型只能靠 read_tool_result 取回。
    assert.throws(() => resolveWorkspacePath(workspaceRoot, String(second.archivePath), config.workspace.ignore));
    const reader = coordinator.createTools().read_tool_result as unknown as ExecutableTool;
    const reread = await reader.execute({ archivePath: second.archivePath }, toolOptions("reread")) as Record<string, unknown>;
    assert.equal(reread.tool, "large_result");
    assert.equal(String(reread.content).includes("x".repeat(768)), true);
    assert.equal(reread.hasMore, false);

    // 归档引用之外的路径一律拒绝，工具参数不能借它读到任意文件。
    for (const escape of ["../../etc/passwd", ".agent/sessions/archive-test.jsonl", ".agent/tool-results/../sessions/x.jsonl"]) {
      const denied = await reader.execute({ archivePath: escape }, toolOptions(`escape-${escape}`)) as Record<string, unknown>;
      assert.equal(typeof denied.error, "string", `${escape} should be refused`);
      assert.equal(denied.content, undefined);
    }

    // 预算是模型侧的上限：超额后每条结果都塌缩成引用，preview 不会每步再塞一份。
    let inlineBytes = 0;
    for (let index = 0; index < 12; index += 1) {
      const later = await tool.execute({}, toolOptions(`overflow-${String(index)}`));
      inlineBytes += Buffer.byteLength(JSON.stringify(later), "utf8");
    }
    assert.equal(inlineBytes < 12 * 768, true, `later results should collapse to references, saw ${String(inlineBytes)} bytes`);
    await recorder.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function largeResultTool(): Tool<Record<string, never>, string> {
  return {
    name: "large_result",
    description: "Return a deliberately large read-only result.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "read",
    resolveExecution() {
      return {
        approvalRule: "large_result",
        async execute() {
          return "x".repeat(768);
        }
      };
    }
  };
}

function toolOptions(toolCallId: string): ToolExecutionOptions<unknown> {
  return { toolCallId, abortSignal: undefined } as ToolExecutionOptions<unknown>;
}

await main();
