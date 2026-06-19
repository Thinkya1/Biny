import { promises as fs } from "node:fs";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";

export interface SearchFilesArgs {
  query: string;
  maxResults?: number;
}

export interface SearchFilesResult {
  matches: SearchFilesMatch[];
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  text: string;
}

export function createSearchFilesTool(context: ToolContext): Tool<SearchFilesArgs, SearchFilesResult> {
  return {
    name: "search_files",
    description: "Search text in workspace files.",
    async execute(args) {
      const query = args.query.trim();
      if (!query) throw new Error("search_files requires a non-empty query.");

      const maxResults = args.maxResults ?? 50;
      const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, 1000);
      const matches: SearchFilesMatch[] = [];

      // search_files 是只读工具，但仍然逐个文件走 workspace path 校验和 ignore 规则。
      for (const file of files) {
        if (matches.length >= maxResults) break;
        const absolutePath = resolveWorkspacePath(context.workspaceRoot, file, context.ignore);
        let content: string;
        try {
          content = await fs.readFile(absolutePath, "utf8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (matches.length >= maxResults) break;
          const text = lines[index] ?? "";
          if (text.includes(query)) {
            matches.push({ path: file, line: index + 1, text: text.trim() });
          }
        }
      }

      return { matches };
    }
  };
}
