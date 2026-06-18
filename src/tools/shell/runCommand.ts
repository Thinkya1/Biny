import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../types.js";

const execAsync = promisify(exec);

export interface RunCommandArgs {
  command: string;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DANGEROUS_PATTERNS = [/rm\s+-rf/, /\bsudo\b/, /chmod\s+-R/, /chown\s+-R/, /\bdd\b/, /\bmkfs\b/, /curl\b.*\|\s*sh/, /wget\b.*\|\s*sh/];

export function createRunCommandTool(context: ToolContext): Tool<RunCommandArgs, RunCommandResult> {
  return {
    name: "run_command",
    description: "Run a local shell command in the workspace.",
    async execute(args) {
      if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(args.command))) {
        throw new Error(`Refusing dangerous command: ${args.command}`);
      }

      try {
        const result = await execAsync(args.command, {
          cwd: context.workspaceRoot,
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        if (isExecError(error)) {
          return {
            stdout: error.stdout ?? "",
            stderr: error.stderr ?? error.message,
            exitCode: typeof error.code === "number" ? error.code : 1
          };
        }
        throw error;
      }
    }
  };
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ("stdout" in error || "stderr" in error || "code" in error);
}
