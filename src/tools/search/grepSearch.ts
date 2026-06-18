import { promises as fs } from "node:fs";
import path from "node:path";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import type { Tool, ToolContext } from "../types.js";

export interface GrepSearchArgs {
  query: string;
  limit?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepSearchResult {
  matches: GrepMatch[];
}

export function createGrepSearchTool(context: ToolContext): Tool<GrepSearchArgs, GrepSearchResult> {
  return {
    name: "grep_search",
    description: "Search for a keyword in workspace files.",
    async execute(args) {
      const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, 500);
      const matches: GrepMatch[] = [];
      const limit = args.limit ?? 100;

      for (const file of files) {
        if (matches.length >= limit) break;
        const absolutePath = path.join(context.workspaceRoot, file);
        let content = "";
        try {
          content = await fs.readFile(absolutePath, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        lines.forEach((lineText, index) => {
          if (matches.length < limit && lineText.includes(args.query)) {
            matches.push({ path: file, line: index + 1, text: lineText });
          }
        });
      }

      return { matches };
    }
  };
}
