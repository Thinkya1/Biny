/**
 * Shell 命令工具模块。
 *
 * `run_command` 在当前工作区执行本地 shell 命令，并把 stdout、stderr 和退出码统一返回。
 * 命令是否安全、是否需要确认由权限层处理，这里只负责受限超时和输出收集。
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

const maxOutputBytes = 1024 * 1024;

export interface RunCommandArgs {
  command: string;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function createRunCommandTool(context: ToolContext): Tool<RunCommandArgs, RunCommandResult> {
  return {
    name: "run_command",
    description: "Run a local shell command in the workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Shell command to run in the workspace." }
      },
      required: ["command"],
      additionalProperties: false
    },
    schema: z.object({ command: z.string().min(1) }),
    capability: "shell.execute",
    risk: "execute",
    resolveExecution(args) {
      const preview = args.command.length > 80 ? `${args.command.slice(0, 80)}...` : args.command;
      return {
        accesses: ToolAccesses.all(),
        display: { kind: "command", command: args.command, cwd: context.workspaceRoot, language: "bash" },
        description: `Run ${preview}`,
        approvalRule: `run_command(${args.command})`,
        async execute({ signal, onUpdate }) {
          return await runShellCommand(context.workspaceRoot, args.command, signal, onUpdate);
        }
      };
    }
  };
}

async function runShellCommand(
  cwd: string,
  command: string,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { kind: "stdout" | "stderr" | "status"; text: string }) => void) | undefined
): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, { cwd, shell: true });
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      stderr += "\nCommand timed out after 120000ms.";
    }, 120_000);
    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      stderr += "\nCommand interrupted.";
    };

    signal?.addEventListener("abort", abort, { once: true });
    onUpdate?.({ kind: "status", text: `Started: ${command}` });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendCapped(stdout, text);
      onUpdate?.({ kind: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendCapped(stderr, text);
      onUpdate?.({ kind: "stderr", text });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      const exitCode = typeof code === "number" ? code : 1;
      onUpdate?.({ kind: "status", text: `Exited with ${String(exitCode)}` });
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function appendCapped(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) return next;
  const overflow = Buffer.byteLength(next, "utf8") - maxOutputBytes;
  return next.slice(Math.min(overflow, next.length));
}
