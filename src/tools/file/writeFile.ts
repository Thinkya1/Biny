/**
 * 文件写入工具模块。
 *
 * `write_file` 会在工作区内创建必要父目录并写入完整文件内容。是否允许写入、如何展示 diff、
 * 以及用户是否确认，都由 agent loop 在调用这个工具前完成。
 */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { atomicWriteUtf8File } from "./safeFileIo.js";

export interface WriteFileArgs {
  // path 可以创建新文件，但父目录必须已存在并通过 workspace canonical 校验。
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
    description: "Atomically write a file inside an existing workspace directory.",
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
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      return {
        accesses: ToolAccesses.writeFile(absolutePath),
        display: { kind: "file_io", operation: "write", path: args.path, content: args.content },
        description: `Write ${args.path}`,
        approvalRule: `write_file(${args.path})`,
        async execute({ signal, approvedFile }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The write target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) {
            throw new Error("The approved write target does not match the prepared tool target.");
          }
          const bytes = await atomicWriteUtf8File(
            absolutePath,
            args.content,
            approvedFile ? approvedFile.snapshot : undefined,
            signal
          );
          return { path: args.path, bytes };
        }
      };
    }
  };
}
