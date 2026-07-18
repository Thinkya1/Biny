/**
 * 文本搜索工具模块。
 *
 * `search_files` 会扫描工作区文件并按行做子串匹配，返回路径、行号和裁剪后的命中文本。
 * 读取每个文件前都会再次走 workspace 路径校验，搜索失败的文件会被跳过而不是中断整次搜索。
 */
import { z } from "zod";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { maxSearchFileBytes, readBoundedUtf8File } from "../file/safeFileIo.js";

export interface SearchFilesArgs {
  query: string;
  maxResults?: number;
}

export interface SearchFilesResult {
  matches: SearchFilesMatch[];
  truncatedFiles?: string[];
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  text: string;
}

export function createSearchFilesTool(context: ToolContext): Tool<SearchFilesArgs, SearchFilesResult> {
  return {
    name: "search_files",
    description: `Search text in workspace files. Each file is limited to its first ${String(maxSearchFileBytes)} bytes; truncated paths are returned in truncatedFiles.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Plain text query to search for." },
        maxResults: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of matches to return." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(500).optional()
    }),
    capability: "filesystem.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.searchTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "search", path: ".", detail: args.query },
        description: `Search files for ${args.query}`,
        approvalRule: `search_files(${args.query})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          const query = args.query.trim();
          if (!query) throw new Error("search_files requires a non-empty query.");

          const maxResults = args.maxResults ?? 50;
          const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, 1000, signal);
          const matches: SearchFilesMatch[] = [];
          const truncatedFiles: string[] = [];

          // search_files 是只读工具，但仍然逐个文件走 workspace path 校验和 ignore 规则。
          for (const file of files) {
            signal?.throwIfAborted();
            if (matches.length >= maxResults) break;
            const absolutePath = resolveWorkspacePath(context.workspaceRoot, file, context.ignore);
            let content: string;
            try {
              const result = await readBoundedUtf8File(absolutePath, maxSearchFileBytes, "truncate", signal);
              content = result.content;
              if (result.truncated) truncatedFiles.push(file);
            } catch (error) {
              if (signal?.aborted) throw error;
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

          const result: SearchFilesResult = { matches };
          if (truncatedFiles.length > 0) result.truncatedFiles = truncatedFiles;
          return result;
        }
      };
    }
  };
}
