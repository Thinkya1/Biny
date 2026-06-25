/**
 * Git 状态工具模块。
 *
 * `git_status` 只是 `git status --short` 的轻量封装，用于让 agent 或界面快速查看工作区变更。
 * 非 Git 仓库或命令失败时返回错误文本，而不是让辅助工具打断整个流程。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface GitStatusResult {
  output: string;
}

export function createGitStatusTool(context: ToolContext): Tool<Record<string, never>, GitStatusResult> {
  // status 输出保持 git 原始短格式，方便上层直接展示或交给模型分析。
  return {
    name: "git_status",
    description: "Run git status --short.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}).default({}),
    capability: "git.status",
    risk: "read",
    resolveExecution() {
      return {
        accesses: ToolAccesses.readTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "git", path: ".", detail: "git status --short" },
        description: "Run git status --short",
        approvalRule: "git_status",
        async execute() {
          try {
            const result = await execFileAsync("git", ["status", "--short"], { cwd: context.workspaceRoot });
            return { output: result.stdout };
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    }
  };
}
