import { promises as fs } from "node:fs";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";

export interface EditFileArgs {
  path: string;
  oldText: string;
  newText: string;
}

export interface EditFileResult {
  path: string;
  replacements: number;
}

export function createEditFileTool(context: ToolContext): Tool<EditFileArgs, EditFileResult> {
  return {
    name: "edit_file",
    description: "Edit a file by replacing oldText with newText.",
    async execute(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const content = await fs.readFile(absolutePath, "utf8");
      if (!content.includes(args.oldText)) {
        throw new Error(`oldText was not found in ${args.path}`);
      }
      const next = content.replace(args.oldText, args.newText);
      await fs.writeFile(absolutePath, next, "utf8");
      return { path: args.path, replacements: 1 };
    }
  };
}
