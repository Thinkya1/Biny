import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ToolExecutionCoordinator,
  type ToolExecutionBudget
} from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

interface ExecutableTool {
  execute(toolCallId: string, input: Record<string, unknown>): Promise<unknown>;
}

type CoordinatorEvent = AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>;

async function testBatchCannotExceedToolCallLimit(): Promise<void> {
  const fixture = await createFixture({
    maxToolCalls: 2,
    maxRepeatedActions: 10
  });
  try {
    const results = await Promise.all([
      fixture.tool.execute("call-a", { key: "a" }),
      fixture.tool.execute("call-b", { key: "b" }),
      fixture.tool.execute("call-c", { key: "c" })
    ]);
    await fixture.coordinator.waitForIdle();

    assert.equal(fixture.resolveCount(), 2, "over-budget calls must not reach resolveExecution");
    assert.equal(fixture.executeCount(), 2, "over-budget calls must not execute");
    assert.deepEqual(results[2], {
      status: "budget_rejected",
      reason: "tool_call_limit",
      resumable: true,
      limit: 2,
      attemptedToolCallCount: 3,
      attemptedActionCount: 1,
      error: "Tool counted_tool was not executed because the run reached its 2-call limit."
    });
    assert.equal(
      fixture.events.some((event) =>
        event.type === "tool.failed"
        && event.toolCallId === "call-c"
        && readString(event.result, "reason") === "tool_call_limit"
      ),
      true
    );
    assert.deepEqual(fixture.coordinator.getExecutionBudgetSnapshot(), {
      accountedToolCalls: 3,
      maxRepeatedActionCount: 1
    });
  } finally {
    await fixture.close();
  }
}

async function testBatchCannotExceedRepeatedActionLimit(): Promise<void> {
  const fixture = await createFixture({
    maxToolCalls: 10,
    maxRepeatedActions: 2
  });
  try {
    const results = await Promise.all([
      fixture.tool.execute("repeat-1", { key: "same" }),
      fixture.tool.execute("repeat-2", { key: "same" }),
      fixture.tool.execute("repeat-3", { key: "same" })
    ]);
    await fixture.coordinator.waitForIdle();

    assert.equal(fixture.resolveCount(), 2, "repeated calls beyond the limit must not resolve");
    assert.equal(fixture.executeCount(), 2, "repeated calls beyond the limit must not execute");
    assert.deepEqual(results[2], {
      status: "budget_rejected",
      reason: "repeated_action_limit",
      resumable: true,
      limit: 2,
      attemptedToolCallCount: 3,
      attemptedActionCount: 3,
      error: "Tool counted_tool was not executed because the same structured action reached its repeat limit of 2."
    });
    assert.equal(
      fixture.events.some((event) =>
        event.type === "tool.failed"
        && event.toolCallId === "repeat-3"
        && readString(event.result, "reason") === "repeated_action_limit"
      ),
      true
    );
    assert.deepEqual(fixture.coordinator.getExecutionBudgetSnapshot(), {
      accountedToolCalls: 3,
      maxRepeatedActionCount: 3
    });
  } finally {
    await fixture.close();
  }
}

async function createFixture(budget: ToolExecutionBudget): Promise<{
  coordinator: ToolExecutionCoordinator;
  tool: ExecutableTool;
  events: CoordinatorEvent[];
  resolveCount(): number;
  executeCount(): number;
  close(): Promise<void>;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-budget-"));
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  config.agent.maxConcurrentTools = 4;
  const registry = new ToolRegistry();
  let resolved = 0;
  let executed = 0;
  registry.register({
    name: "counted_tool",
    description: "Count executions for admission-budget tests.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false
    },
    schema: z.object({ key: z.string() }),
    risk: "read",
    resolveExecution(args: { key: string }) {
      resolved += 1;
      return {
        approvalRule: "counted_tool",
        async execute() {
          executed += 1;
          return { key: args.key };
        }
      };
    }
  } as Tool);
  const recorder = new SessionRecorder(workspaceRoot, "tool-budget");
  const events: CoordinatorEvent[] = [];
  const coordinator = new ToolExecutionCoordinator(
    {
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    },
    new PermissionManager(config.permission),
    (event) => events.push(event),
    () => ({}),
    undefined,
    budget
  );
  return {
    coordinator,
    tool: nativeTool(coordinator, "counted_tool"),
    events,
    resolveCount: () => resolved,
    executeCount: () => executed,
    close: async () => {
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function nativeTool(coordinator: ToolExecutionCoordinator, name: string): ExecutableTool {
  const tool = coordinator.createAgentTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return {
    execute: async (toolCallId, input) => {
      const result = await tool.execute(toolCallId, input);
      return result.details ?? result;
    }
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

await testBatchCannotExceedToolCallLimit();
await testBatchCannotExceedRepeatedActionLimit();

console.log("native tool coordinator tests passed");
