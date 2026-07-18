/**
 * 文件读取工具模块。
 *
 * `read_file` 读取工作区内通过路径校验的 UTF-8 文本文件；桌面端还可读取由应用保存的
 * `@attachments/` 虚拟路径，但不能借此访问任意用户目录。
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
    description: "Read a file inside the workspace or a supplied attachment.",
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
        accesses: ToolAccesses.readFile(resolveReadablePath(context, args.path)),
        display: { kind: "file_io", operation: "read", path: args.path },
        description: `Read ${args.path}`,
        approvalRule: `read_file(${args.path})`,
        async execute() {
          const absolutePath = resolveReadablePath(context, args.path);
          const content = await fs.readFile(absolutePath, "utf8");
          return { path: args.path, content };
        }
      };
    }
  };
}

function resolveReadablePath(context: ToolContext, requestedPath: string): string {
  const attachmentPrefix = "@attachments/";
  if (!requestedPath.startsWith(attachmentPrefix)) {
    return resolveWorkspacePath(context.workspaceRoot, requestedPath, context.ignore);
  }
  if (!context.attachmentRoot) throw new Error("No attachments are available for this session.");
  const relativePath = requestedPath.slice(attachmentPrefix.length);
  const absolutePath = path.resolve(context.attachmentRoot, relativePath);
  const relativeToRoot = path.relative(context.attachmentRoot, absolutePath);
  if (!relativePath || relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === ".." || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Attachment path escapes its storage directory: ${requestedPath}`);
  }
  return absolutePath;
}
