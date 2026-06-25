/**
 * 文件列表工具模块。
 *
 * `list_files` 复用 workspace scanner，在 ignore 规则和数量限制内返回工作区文件列表。
 * 它用于让 agent 快速获得项目轮廓，而不是完整读取文件内容。
 */
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { z } from "zod";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface ListFilesArgs {
  // limit 用于保护大型仓库，避免一次性把全部文件塞进响应。
  limit?: number;
}

export interface ListFilesResult {
  files: string[];
}

export function createListFilesTool(context: ToolContext): Tool<ListFilesArgs, ListFilesResult> {
  // 文件枚举统一复用 workspace scanner，保证 CLI、搜索和项目上下文的忽略规则一致。
  return {
    name: "list_files",
    description: "List workspace files.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of files to return." }
      },
      required: [],
      additionalProperties: false
    },
    schema: z.object({ limit: z.number().int().positive().max(1000).optional() }).default({}),
    capability: "filesystem.list",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.searchTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "list", path: ".", detail: `limit ${String(args.limit ?? 200)}` },
        description: "List workspace files",
        approvalRule: "list_files",
        async execute() {
          const files = await scanWorkspaceFiles(context.workspaceRoot, context.ignore, args.limit ?? 200);
          return { files };
        }
      };
    }
  };
}
