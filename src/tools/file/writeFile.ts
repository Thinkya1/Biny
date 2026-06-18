import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

export function createWriteFileTool(context: ToolContext): Tool<WriteFileArgs, WriteFileResult> {
  return {
    name: "write_file",
    description: "Write a file inside the workspace.",
    async execute(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, args.content, "utf8");
      return { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
    }
  };
}
