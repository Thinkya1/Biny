import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface GitDiffResult {
  output: string;
}

export function createGitDiffTool(context: ToolContext): Tool<Record<string, never>, GitDiffResult> {
  return {
    name: "git_diff",
    description: "Run git diff.",
    async execute() {
      try {
        const result = await execFileAsync("git", ["diff"], { cwd: context.workspaceRoot, maxBuffer: 1024 * 1024 });
        return { output: result.stdout };
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
