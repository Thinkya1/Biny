#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";

const program = new Command();
const workspaceRoot = process.cwd();

program.name("biny").description("Biny TypeScript coding agent").version("0.1.0");

program.command("init").description("Initialize config and .agent directories").action(wrap(() => initCommand(workspaceRoot)));
program.command("doctor").description("Check local environment").action(wrap(() => doctorCommand(workspaceRoot)));
program.command("chat").description("Start interactive chat").action(wrap(() => chatCommand(workspaceRoot)));
program
  .command("run")
  .description("Run a one-shot agent task")
  .argument("<input...>", "task text")
  .action((input: string[]) => wrap(() => runCommand(workspaceRoot, input.join(" ")))());

await program.parseAsync(process.argv);

function wrap(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}
