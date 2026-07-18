/**
 * Git diff 工具模块。
 *
 * `git_diff` 读取当前工作区的 `git diff` 文本，供用户查看未提交修改或交给模型分析。
 * 它保持原始 diff 输出，不尝试解析 hunk，也会把失败原因作为文本返回。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { filterProtectedGitDiff, protectedGitPathspecs, redactSecrets } from "../../utils/secrets.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { gitInspectionEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);

export interface GitDiffResult {
  output: string;
}

export function createGitDiffTool(context: ToolContext): Tool<Record<string, never>, GitDiffResult> {
  // git 工具在非 Git 仓库中也返回文本结果，避免一个辅助命令中断整个 agent 流程。
  return {
    name: "git_diff",
    description: "Run git diff.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}).default({}),
    capability: "git.diff",
    risk: "read",
    resolveExecution() {
      return {
        accesses: ToolAccesses.readTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "git", path: ".", detail: "git diff" },
        description: "Run git diff",
        approvalRule: "git_diff",
        async execute({ signal }) {
          try {
            const result = await execFileAsync("git", [
              "--no-pager",
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "diff.external=",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--ignore-submodules=all",
              "--",
              ".",
              ...protectedGitPathspecs()
            ], { cwd: context.workspaceRoot, env: gitInspectionEnvironment(), maxBuffer: 1024 * 1024, timeout: 30_000, signal });
            return { output: redactSecrets(filterProtectedGitDiff(result.stdout)) };
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    }
  };
}
