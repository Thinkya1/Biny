import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

export interface GitStatusResult {
  output: string;
}

export function createGitStatusTool(context: ToolContext): Tool<Record<string, never>, GitStatusResult> {
  return {
    name: "git_status",
    description: "Run git status --short.",
    async execute() {
      try {
        const result = await execFileAsync("git", ["status", "--short"], { cwd: context.workspaceRoot });
        return { output: result.stdout };
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}
