import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureAgentDirs } from "../src/session/store.js";
import { TodoStore, maxTodoItems } from "../src/session/todoStore.js";
import { createTodoTool } from "../src/tools/todo.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-todo-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    await testReplaceAndPrompt(workspaceRoot);
    await testConstraints(workspaceRoot);
    await testSurvivesReload(workspaceRoot);
    await testToolRoundTrip(workspaceRoot);
    console.log("todo plan tests passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testReplaceAndPrompt(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-a");
  await store.initialize();
  assert.equal(store.promptSection(), undefined, "an empty plan must not take up prompt space");

  await store.replace([
    { content: "read the failing test", status: "completed" },
    { content: "fix the parser", status: "in_progress" },
    { content: "run the suite", status: "pending" }
  ]);
  const prompt = store.promptSection() ?? "";
  assert.equal(prompt.includes("1. [x] read the failing test"), true);
  assert.equal(prompt.includes("2. [>] fix the parser"), true);
  assert.equal(prompt.includes("3. [ ] run the suite"), true);
}

async function testConstraints(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-b");
  await store.initialize();
  // 同时两项 in_progress 说明模型没在收敛注意力，直接拒绝并把原因说清楚。
  await assert.rejects(store.replace([
    { content: "a", status: "in_progress" },
    { content: "b", status: "in_progress" }
  ]), /one plan item/);
  await assert.rejects(store.replace([{ content: "   ", status: "pending" }]), /non-empty/);
  await assert.rejects(store.replace(
    Array.from({ length: maxTodoItems + 1 }, (_, index) => ({ content: `item ${String(index)}`, status: "pending" as const }))
  ), /at most/);
  // 被拒的写入不能留下痕迹。
  assert.deepEqual(store.list(), []);
}

/** 恢复会话后计划要还在 —— 否则它挡不住「压缩之后忘了还有第 3 步」。 */
async function testSurvivesReload(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-c");
  await store.initialize();
  await store.replace([{ content: "persisted item", status: "pending" }]);

  const reopened = new TodoStore(workspaceRoot, "plan-c");
  await reopened.initialize();
  assert.deepEqual(reopened.list(), [{ content: "persisted item", status: "pending" }]);

  // 别的会话看不到这份清单。
  const other = new TodoStore(workspaceRoot, "plan-d");
  await other.initialize();
  assert.deepEqual(other.list(), []);
}

async function testToolRoundTrip(workspaceRoot: string): Promise<void> {
  const store = new TodoStore(workspaceRoot, "plan-e");
  await store.initialize();
  const tool = createTodoTool(store);
  const execution = await tool.resolveExecution({
    todos: [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" }
    ]
  });
  if (!("execute" in execution)) throw new Error("update_todos did not resolve to a runnable execution.");
  const result = await execution.execute({ toolCallId: "todo-test" });
  assert.equal(result.remaining, 1);
  assert.equal(result.todos.length, 2);
  assert.equal(store.promptSection()?.includes("step two"), true);
}

await main();
