/**
 * 文件读取工具模块。
 *
 * `read_file` 只读取工作区内通过路径校验的 UTF-8 文本文件，并按用户传入的相对路径返回内容。
 * 它不负责解释文件，也不绕过 workspace ignore 规则。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface ReadFileArgs {
  // 工具层只接受相对路径；resolveWorkspacePath 会拒绝 ../ 和被忽略的目录。
  path: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export function createReadFileTool(context: ToolContext): Tool<ReadFileArgs, ReadFileResult> {
  // read_file 是最小只读工具：解析路径、读 utf8、按原路径返回内容。
  return {
    name: "read_file",
    description: "Read a file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative UTF-8 text file path to read." }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1) }),
    capability: "filesystem.read",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.readFile(path.join(context.workspaceRoot, args.path)),
        display: { kind: "file_io", operation: "read", path: args.path },
        description: `Read ${args.path}`,
        approvalRule: `read_file(${args.path})`,
        async execute() {
          const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          const content = await fs.readFile(absolutePath, "utf8");
          return { path: args.path, content };
        }
      };
    }
  };
}
