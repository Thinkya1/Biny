/**
 * Git 提交工具模块。
 *
 * 提交是不可忽略的副作用，所以走完整权限确认，且只提交显式给出的路径 —— 不提供 `-A`。
 * 用户工作区里常有 agent 不该替他决定的改动，"把所有东西提交上去"是最容易造成损失的默认值。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);
const maxSubjectLength = 500;

const gitCommitSchema = z.object({
  message: z.string().min(1).max(4_000),
  paths: z.array(z.string().min(1)).min(1).max(200)
});

export type GitCommitArgs = z.infer<typeof gitCommitSchema>;

export interface GitCommitResult {
  commit: string;
  committedPaths: string[];
  output: string;
}

export function createGitCommitTool(context: ToolContext): Tool<GitCommitArgs, GitCommitResult> {
  return {
    name: "git_commit",
    description: "Stage the given workspace paths and create a git commit. Paths must be listed explicitly; there is no commit-everything option.",
    promptSnippet: "Stage explicit workspace paths and create a Git commit",
    promptGuidelines: ["Use git_commit only when the user explicitly asks for a commit, and pass only the intended paths"],
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 4_000, description: "Commit message." },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "string", minLength: 1 },
          description: "Workspace-relative paths to stage and commit."
        }
      },
      required: ["message", "paths"],
      additionalProperties: false
    },
    schema: gitCommitSchema,
    capability: "git.commit",
    risk: "write",
    resolveExecution(args) {
      // 路径校验放在权限询问之前，越界路径不该先弹一个确认框再失败。
      const absolutePaths = args.paths.map((entry) => resolveWorkspacePath(context.workspaceRoot, entry, context.ignore));
      const relativePaths = absolutePaths.map((entry) => toWorkspaceRelative(context.workspaceRoot, entry));
      const subject = args.message.split("\n")[0]?.slice(0, maxSubjectLength) ?? "";
      return {
        accesses: ToolAccesses.readWriteTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "git", path: relativePaths.join(", "), detail: `git commit -m ${JSON.stringify(subject)}` },
        description: `Commit ${String(relativePaths.length)} path(s): ${subject}`,
        approvalRule: `git_commit(${relativePaths.join(",")})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          await execFileAsync("git", ["add", "--", ...relativePaths], { cwd: context.workspaceRoot, signal });
          const staged = await execFileAsync("git", ["diff", "--cached", "--name-only", "--", ...relativePaths], {
            cwd: context.workspaceRoot,
            signal
          });
          if (!staged.stdout.trim()) {
            throw new Error("Nothing to commit: the given paths have no staged changes.");
          }
          const committed = await execFileAsync("git", ["commit", "-m", args.message, "--only", "--", ...relativePaths], {
            cwd: context.workspaceRoot,
            signal
          });
          const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: context.workspaceRoot, signal });
          return {
            commit: head.stdout.trim(),
            committedPaths: relativePaths,
            output: `${committed.stdout}${committed.stderr}`.trim()
          };
        }
      };
    }
  };
}
