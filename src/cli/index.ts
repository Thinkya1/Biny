#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionsCommand } from "./commands/sessions.js";
import { planCommand } from "./commands/plan.js";
import { tuiCommand } from "./commands/tui.js";

const program = new Command();
const workspaceRoot = process.cwd();

program.name("biny").description("Biny TypeScript coding agent").version("0.1.0");

program.command("init").description("Initialize config and .agent directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program.command("chat").description("Start interactive chat").action(wrap(() => chatCommand(workspaceRoot)));
program.command("tui").description("Start terminal UI mode").action(wrap(() => tuiCommand(workspaceRoot)));
program.command("sessions").description("List recorded sessions").action(wrap(() => sessionsCommand(workspaceRoot)));
program
  .command("plan")
  .description("Create a plan without executing write, edit, or command tools")
  .argument("<task...>", "task text")
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

// 不带子命令时默认进入 chat，这是当前最常用的入口；help 仍可通过 `biny help` 查看。
if (process.argv.length <= 2) {
  await wrap(() => chatCommand(workspaceRoot))();
} else {
  await program.parseAsync(process.argv);
}

function wrap(fn: () => Promise<void>): () => Promise<void> {
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
