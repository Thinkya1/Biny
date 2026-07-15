#!/usr/bin/env node
/**
 * Biny 的命令行入口模块。
 *
 * 这里集中声明 `init`、`run`、`chat`、`tui` 等子命令，并把执行逻辑转交给
 * `commands/` 下的具体实现。入口层只处理参数拼接、默认 TUI 和异常展示，
 * 不直接承载 agent、工具或 TUI 的业务流程。
 */
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";
import { chatCommand, type ChatCommandOptions } from "./commands/chat.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionsCommand } from "./commands/sessions.js";
import { planCommand } from "./commands/plan.js";
import { tuiCommand } from "./commands/tui.js";

const program = new Command();
// CLI 的工作区以用户执行 biny 时的当前目录为准。
const workspaceRoot = process.cwd();

program.name("biny").description("Biny local desktop assistant").version("0.1.0");

program.command("init").description("Initialize config and .agent directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program
  .command("chat")
  .description("Start interactive chat")
  .option("-c, --continue", "continue the latest recorded session")
  .option("-s, --session <id>", "continue a specific session id or .jsonl path")
  .action((options: ChatCommandOptions) => wrap(() => chatCommand(workspaceRoot, options))());
program.command("tui").description("Start terminal UI mode").action(wrap(() => tuiCommand(workspaceRoot)));
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
  .argument("<input...>", "task text")
  .action((input: string[]) => wrap(() => runCommand(workspaceRoot, input.join(" ")))());
program
  .command("resume")
  .description("Print history from an existing session")
  .argument("[session]", "session id, .jsonl path, or omit for latest")
  .action((session: string | undefined) => wrap(() => resumeCommand(workspaceRoot, session))());


if (process.argv.length <= 2) {
  await wrap(() => tuiCommand(workspaceRoot))();
} else {
  await program.parseAsync(process.argv);
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
