/**
 * 工具基础契约模块。
 *
 * 所有内置工具都实现同一组 `name`、`description` 和 `execute` 字段，并共享当前 workspace root
 * 与 ignore 规则。权限判断、session 记录和 UI 展示不放在工具里，而由调用方统一处理。
 */
import type { z } from "zod";
import type { ToolAccessList } from "./access.js";
import type { JsonObjectSchema } from "./schema.js";

export type ToolSource = "builtin" | "mcp" | "skill" | "plugin" | "subagent";
export type ToolRisk = "read" | "write" | "execute";

export type ToolUpdateKind = "stdout" | "stderr" | "progress" | "status" | "custom";

export interface ToolUpdate {
  kind: ToolUpdateKind;
  text?: string;
  percent?: number;
  customKind?: string;
  customData?: unknown;
}

export interface ToolExecutionContext {
  toolCallId: string;
  signal?: AbortSignal;
  onUpdate?: (update: ToolUpdate) => void;
}

export type ToolInputDisplay =
  | { kind: "file_io"; operation: "read" | "write" | "edit" | "list" | "search" | "grep" | "git"; path?: string; content?: string; before?: string; after?: string; detail?: string }
  | { kind: "command"; command: string; cwd?: string; description?: string; language?: string }
  | { kind: "generic"; summary: string; detail?: unknown };

export interface RunnableToolExecution<TResult = unknown> {
  accesses?: ToolAccessList;
  display?: ToolInputDisplay;
  description?: string;
  approvalRule: string;
  matchesRule?: (ruleArgs: string) => boolean;
  execute(context: ToolExecutionContext): Promise<TResult>;
}

export type ToolExecution<TResult = unknown> = RunnableToolExecution<TResult> | { isError: true; result: TResult; errorMessage: string };

export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
  schema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  source?: ToolSource;
  capability?: string;
  risk?: ToolRisk;
  // resolveExecution 声明本次调用的展示信息、权限规则、资源访问范围和真正执行函数。
  resolveExecution(args: TArgs): ToolExecution<TResult> | Promise<ToolExecution<TResult>>;
}

export interface ToolContext {
  // 所有内置工具都绑定在当前 workspace 内，不能自行选择任意系统路径。
  workspaceRoot: string;
  ignore: string[];
}
