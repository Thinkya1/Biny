/**
 * 计划清单工具模块。
 *
 * 模型用它维护跨回合的工作计划。清单每回合注入 system prompt，所以写进去的内容不会因为
 * 历史压缩而丢失。
 */
import { z } from "zod";
import { maxTodoContentLength, maxTodoItems, type TodoStore } from "../session/todoStore.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

const todoItemSchema = z.object({
  content: z.string().min(1).max(maxTodoContentLength),
  status: z.enum(["pending", "in_progress", "completed"])
});
const updateTodosSchema = z.object({ todos: z.array(todoItemSchema).max(maxTodoItems) });

export type UpdateTodosArgs = z.infer<typeof updateTodosSchema>;

export interface UpdateTodosResult {
  todos: Array<{ content: string; status: string }>;
  remaining: number;
}

export function createTodoTool(store: TodoStore): Tool<UpdateTodosArgs, UpdateTodosResult> {
  return {
    name: "update_todos",
    description: [
      "Record or update your plan for the current task. Pass the complete list every time; it replaces the previous one.",
      "Use it for work that takes several steps: write the plan before starting, mark exactly one item in_progress while you work on it, and mark items completed as soon as they are actually done.",
      "The list is shown back to you every turn, so it survives context compaction. Skip it for single-step requests."
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: maxTodoItems,
          description: "The complete plan, in order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1, maxLength: maxTodoContentLength, description: "What needs to be done." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "At most one item may be in_progress." }
            },
            required: ["content", "status"],
            additionalProperties: false
          }
        }
      },
      required: ["todos"],
      additionalProperties: false
    },
    schema: updateTodosSchema,
    // 与 filesystem.* 分开：subagent 有自己的任务边界，不该改父会话的计划。
    capability: "plan.todos",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Update plan", detail: args.todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n") },
        description: `Update the plan (${String(args.todos.length)} items)`,
        approvalRule: "update_todos",
        async execute() {
          const todos = await store.replace(args.todos);
          return { todos, remaining: todos.filter((todo) => todo.status !== "completed").length };
        }
      };
    }
  };
}
