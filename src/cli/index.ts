#!/usr/bin/env node
/**
 * Biny 的命令行入口模块。
 *
 * 这里集中声明 `init`、`run`、`chat`、`tui` 等子命令，并把执行逻辑转交给
 * `commands/` 下的具体实现。入口层只处理参数拼接、默认 TUI 和异常展示，
 * 不直接承载 agent、工具或 TUI 的业务流程。
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand, type RunCommandOptions } from "./commands/run.js";
import { chatCommand, type ChatCommandOptions } from "./commands/chat.js";
import { evalCompareCommand, evalRunCommand } from "./commands/evals.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionsCommand } from "./commands/sessions.js";
import { planCommand } from "./commands/plan.js";
import { tuiCommand } from "./commands/tui.js";

const program = new Command();
// CLI 的工作区以用户执行 biny 时的当前目录为准。
const workspaceRoot = process.cwd();
// `pnpm dev -- <command>` 会把分隔符保留在 tsx 脚本的 argv 中；去掉它，保证开发入口和已安装的 biny 解析一致。
const cliArgv = process.argv[2] === "--"
  ? [...process.argv.slice(0, 2), ...process.argv.slice(3)]
  : process.argv;
// 版本号来自 package.json，界面头部和 `--version` 用同一个来源。
const { version: cliVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

program.name("biny").description("Biny local desktop assistant").version(cliVersion);

program.command("init").description("Initialize config and .biny directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program
  .command("chat")
  .description("Start interactive chat")
  .option("-c, --continue", "continue the latest recorded session")
  .option("-s, --session <id>", "continue a specific session id or .jsonl path")
  .action((options: ChatCommandOptions) => wrap(() => chatCommand(workspaceRoot, options))());
program.command("tui").description("Start terminal UI mode").action(wrap(() => tuiCommand(workspaceRoot, cliVersion)));
program.command("sessions").description("List recorded sessions").action(wrap(() => sessionsCommand(workspaceRoot)));
program
  .command("plan")
  .description("Create a plan without executing write, edit, or command tools")
  .argument("<task...>", "task text")
  // Commander 对可变参数返回数组，这里统一拼回自然语言任务文本。
  .action((task: string[]) => wrap(() => planCommand(workspaceRoot, task.join(" ")))());
program
  .command("run")
  .description("Run a one-shot agent task")
  .option("--model <alias>", "override the configured model alias for this run")
  .option("--max-steps <steps>", "override the hard step limit", parsePositiveInteger)
  .option("--soft-steps <steps>", "override the soft step limit", parsePositiveInteger)
  .option("--permission-mode <mode>", "override permission mode: ask, read-only, auto, full-access")
  .option("--headless", "run without interactive permission prompts")
  .option("--json", "print one machine-readable JSON result")
  .argument("<input...>", "task text")
  .action((input: string[], options: RunCommandOptions) => wrap(async () => { await runCommand(workspaceRoot, input.join(" "), options); })());
const evals = program.command("eval").description("Run and compare agent evaluations");
evals
  .command("run")
  .description("Run the built-in eval suite and write a report")
  .option("--label <label>", "label for this run, used in the report and comparisons")
  .option("--out <path>", "where to write the JSON report")
  .option("--task <id...>", "only run these task ids")
  .action((options: { label?: string; out?: string; task?: string[] }) => wrap(() => evalRunCommand(workspaceRoot, {
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.out === undefined ? {} : { out: options.out }),
    ...(options.task === undefined ? {} : { tasks: options.task })
  }))());
evals
  .command("compare")
  .description("Compare two eval reports")
  .argument("<baseline>", "baseline report path")
  .argument("<candidate>", "candidate report path")
  .action((baseline: string, candidate: string) => wrap(() => evalCompareCommand(baseline, candidate))());

program
  .command("resume")
  .description("Print history from an existing session")
  .argument("[session]", "session id, .jsonl path, or omit for latest")
  .action((session: string | undefined) => wrap(() => resumeCommand(workspaceRoot, session))());


if (cliArgv.length <= 2) {
  await wrap(() => tuiCommand(workspaceRoot, cliVersion))();
} else {
  await program.parseAsync(cliArgv);
}

function wrap(fn: () => Promise<void>): () => Promise<void> {
  // 所有命令都经过 wrap，保证异步异常不会打印冗长堆栈到普通用户界面。
  return async () => {
    try {
      await fn();
    } catch (error) {
      // CLI 层只负责把错误展示给用户，详细事件记录由 runtime / agent 层处理。
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, got: ${value}`);
  return parsed;
}
