/**
 * 文件精确编辑工具模块。
 *
 * `edit_file` 读取目标文件后只做一次 `oldText` 到 `newText` 的精确替换。找不到旧文本时直接失败，
 * 避免模型生成的近似编辑静默落盘。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface EditFileArgs {
  // path 始终是工作区相对路径，真正访问前会统一做越界和 ignore 校验。
  path: string;
  // oldText 必须精确命中文件内容，避免模型或规则把相似片段误改掉。
  oldText: string;
  newText: string;
}

export interface EditFileResult {
  // 返回用户传入的相对路径，避免把本机绝对路径暴露到上层输出。
  path: string;
  replacements: number;
}

export function createEditFileTool(context: ToolContext): Tool<EditFileArgs, EditFileResult> {
  // edit_file 只做一次精确替换；更复杂的多处编辑应由上层拆成多次可审计操作。
  return {
    name: "edit_file",
    description: "Edit a file by replacing oldText with newText.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path to edit." },
        oldText: { type: "string", minLength: 1, description: "Exact existing text to replace." },
        newText: { type: "string", description: "Replacement text." }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() }),
    capability: "filesystem.edit",
    risk: "write",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.readWriteFile(path.join(context.workspaceRoot, args.path)),
        display: { kind: "file_io", operation: "edit", path: args.path, before: args.oldText, after: args.newText },
        description: `Edit ${args.path}`,
        approvalRule: `edit_file(${args.path})`,
        async execute() {
          const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          const content = await fs.readFile(absolutePath, "utf8");
          // 没有命中时直接失败，保证调用方看到的是“未修改”而不是静默成功。
          if (!content.includes(args.oldText)) {
            throw new Error(`oldText was not found in ${args.path}`);
          }
          const next = content.replace(args.oldText, args.newText);
          await fs.writeFile(absolutePath, next, "utf8");
          return { path: args.path, replacements: 1 };
        }
      };
    }
  };
}
