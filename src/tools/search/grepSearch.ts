/**
 * 简单 grep 搜索工具模块。
 *
 * 这个工具提供更直接的关键字扫描能力，按文件逐行查找普通子串，不解析正则。它适合 mock 阶段
 * 和轻量搜索场景，复杂搜索后续可以替换成更强的工具实现。
 */
import { z } from "zod";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { maxSearchFileBytes, readBoundedUtf8File } from "../file/safeFileIo.js";

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
  truncatedFiles?: string[];
}

export function createGrepSearchTool(context: ToolContext): Tool<GrepSearchArgs, GrepSearchResult> {
  // grep_search 是简单子串搜索，不做正则解析；适合 mock 阶段稳定返回可读结果。
  return {
    name: "grep_search",
    description: `Search for a keyword in workspace files. Each file is limited to its first ${String(maxSearchFileBytes)} bytes; truncated paths are returned in truncatedFiles.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Plain text keyword to find." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of matches to return." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(500).optional()
    }),
    capability: "filesystem.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.searchTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "grep", path: ".", detail: args.query },
        description: `Grep for ${args.query}`,
        approvalRule: `grep_search(${args.query})`,
        async execute({ signal }) {
          const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, 500, signal);
          const matches: GrepMatch[] = [];
          const truncatedFiles: string[] = [];
          // limit 同时限制跨文件总匹配数，避免大文件或常见词刷屏。
          const limit = args.limit ?? 100;

          for (const file of files) {
            signal?.throwIfAborted();
            if (matches.length >= limit) break;
            const absolutePath = resolveWorkspacePath(context.workspaceRoot, file, context.ignore);
            let content = "";
            try {
              const result = await readBoundedUtf8File(absolutePath, maxSearchFileBytes, "truncate", signal);
              content = result.content;
              if (result.truncated) truncatedFiles.push(file);
            } catch (error) {
              if (signal?.aborted) throw error;
              // 二进制文件、权限问题或扫描后被删除的文件都跳过，搜索尽量返回已有匹配。
              continue;
            }
            const lines = content.split(/\r?\n/);
            lines.forEach((lineText, index) => {
              if (matches.length < limit && lineText.includes(args.query)) {
                matches.push({ path: file, line: index + 1, text: lineText });
              }
            });
          }

          const result: GrepSearchResult = { matches };
          if (truncatedFiles.length > 0) result.truncatedFiles = truncatedFiles;
          return result;
        }
      };
    }
  };
}
