import { promises as fs } from "node:fs";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";

export interface ReadFileArgs {
  path: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export function createReadFileTool(context: ToolContext): Tool<ReadFileArgs, ReadFileResult> {
  return {
    name: "read_file",
    description: "Read a file inside the workspace.",
    async execute(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const content = await fs.readFile(absolutePath, "utf8");
      return { path: args.path, content };
    }
  };
}
