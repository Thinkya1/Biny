import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runAgentTask } from "../../agent/loop.js";
import { formatProjectContext } from "../../project/ProjectContext.js";
import { withCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { listSessionSummaries } from "../../session/events.js";
import { readInteractiveLine } from "../prompt/interactivePrompt.js";
import type { SlashCommand } from "../prompt/slashMenu.js";
import { printSessionSummaries, sessionsCommand } from "./sessions.js";
import { resumeCommand } from "./resume.js";

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear the terminal", category: "system" },
  { name: "/context", description: "Print the current ProjectContext summary", category: "system" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "List previous sessions in this project", category: "session" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit chat", category: "system" },
  { name: "/quit", description: "Exit chat", category: "system" }
];

export async function chatCommand(workspaceRoot: string): Promise<void> {
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    await runChatLoop(runtime);
  });
}

async function runChatLoop(runtime: CommandRuntime): Promise<void> {
  console.log(`Session: ${runtime.recorder.filePath}`);
  console.log("输入 / 查看命令。使用 ↑/↓ 选择，Enter 确认，Tab 补全，输入 /exit 退出。");
  if (input.isTTY && output.isTTY) {
    while (true) {
      const line = await readInteractiveLine("> ", SLASH_COMMANDS);
      if (line === undefined) break;
      const shouldContinue = await handleInputLine(runtime, line);
      if (!shouldContinue) break;
    }
    return;
  }

  const rl = createInterface({ input, output, completer: completeSlashCommand, prompt: "> " });
  try {
    if (output.isTTY) rl.prompt();
    for await (const line of rl) {
      const shouldContinue = await handleInputLine(runtime, line);
      if (!shouldContinue) break;
      if (output.isTTY) rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function handleInputLine(runtime: CommandRuntime, line: string): Promise<boolean> {
  const text = line.trim();
  if (!text) return true;
  if (text.startsWith("/")) {
    try {
      return await handleSlashCommand(runtime, text);
    } catch (error) {
      // slash command 出错时不要退出当前 chat；例如 /resume 输入了不存在的 session。
      console.error(error instanceof Error ? error.message : String(error));
      return true;
    }
  }
  const result = await runAgentTask(text, runtime);
  console.log(result);
  return true;
}

async function handleSlashCommand(runtime: CommandRuntime, text: string): Promise<boolean> {
  const [command, ...args] = text.split(/\s+/);

  if (command === "/" || command === "/help") {
    printSlashHelp();
    return true;
  }

  if (command === "/exit" || command === "/quit") {
    return false;
  }

  if (command === "/clear") {
    console.clear();
    return true;
  }

  if (command === "/context") {
    console.log(formatProjectContext(runtime.projectContext));
    return true;
  }

  if (command === "/sessions") {
    await sessionsCommand(runtime.workspaceRoot);
    return true;
  }

  if (command === "/resume") {
    if (args[0]) {
      await resumeCommand(runtime.workspaceRoot, args[0]);
      return true;
    }
    printSessionSummaries(await listSessionSummaries(runtime.workspaceRoot));
    return true;
  }

  if (command === "/plan") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Usage: /plan <task>");
      return true;
    }
    runtime.recorder.record({ type: "user_message", content: `plan: ${task}` });
    const plan = [
      "Goal",
      `- ${task}`,
      "",
      "Files To Inspect",
      "- package.json",
      "- README.md",
      "- tsconfig.json",
      "- Relevant files under src/",
      "",
      "Possible Tools",
      "- list_files",
      "- read_file",
      "- search_files",
      "- write_file / edit_file (not executed in plan mode)",
      "- run_command (not executed in plan mode)",
      "",
      "Steps",
      "- Use ProjectContext to understand project structure and current status.",
      "- Search or read relevant files.",
      "- Draft the change approach.",
      "- During execution, show a diff and wait for user confirmation before writing.",
      "",
      "Risks",
      "- MockProvider can only produce conservative plans.",
      "- Plan mode does not execute writes, edits, or commands.",
      "",
      "ProjectContext Summary",
      formatProjectContext(runtime.projectContext).slice(0, 1200)
    ].join("\n");
    runtime.recorder.record({ type: "assistant_message", content: plan });
    console.log(plan);
    return true;
  }

  console.log(`Unknown command: ${command}`);
  printSlashHelp();
  return true;
}

function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS.map((command) => command.name).filter((command) => command.startsWith(line));
  return [hits.length ? hits : SLASH_COMMANDS.map((command) => command.name), line];
}

function printSlashHelp(): void {
  console.log("Available commands:");
  for (const command of SLASH_COMMANDS) {
    console.log(`  ${command.name.padEnd(16)}${command.description}`);
  }
}
