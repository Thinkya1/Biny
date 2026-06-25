/**
 * 文件写入工具模块。
 *
 * `write_file` 会在工作区内创建必要父目录并写入完整文件内容。是否允许写入、如何展示 diff、
 * 以及用户是否确认，都由 agent loop 在调用这个工具前完成。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface WriteFileArgs {
  // path 可以指向尚不存在的子目录，execute 会在写入前创建父目录。
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

export function createWriteFileTool(context: ToolContext): Tool<WriteFileArgs, WriteFileResult> {
  // write_file 的权限确认在 agent loop 完成；这里保持纯粹的文件写入实现。
  return {
    name: "write_file",
    description: "Write a file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path to create or overwrite." },
        content: { type: "string", description: "Complete UTF-8 file content to write." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    capability: "filesystem.write",
    risk: "write",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.writeFile(path.join(context.workspaceRoot, args.path)),
        display: { kind: "file_io", operation: "write", path: args.path, content: args.content },
        description: `Write ${args.path}`,
        approvalRule: `write_file(${args.path})`,
        async execute() {
          const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          // 允许创建新文件所在目录，减少调用方对 mkdir 的额外依赖。
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, args.content, "utf8");
          return { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
        }
      };
    }
  };
}
