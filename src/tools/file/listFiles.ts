import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import type { Tool, ToolContext } from "../types.js";

export interface ListFilesArgs {
  limit?: number;
}

export interface ListFilesResult {
  files: string[];
}

export function createListFilesTool(context: ToolContext): Tool<ListFilesArgs, ListFilesResult> {
  return {
    name: "list_files",
    description: "List workspace files.",
    async execute(args) {
      const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, args.limit ?? 200);
      return { files };
    }
  };
}
