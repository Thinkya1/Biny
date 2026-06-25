/**
 * 交互式 chat 命令模块。
 *
 * 这里启动命令行对话循环，支持 slash command、TTY raw-mode 菜单、非 TTY readline fallback，
 * 并把普通输入交给 agent loop。它只组织交互流程，实际工具执行和权限确认仍由 runtime/agent 层处理。
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runAgentTask } from "../../agent/loop.js";
import { formatProjectContext } from "../../project/ProjectContext.js";
import { runPermissionCommand } from "../../permission/commands.js";
import { withCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { listSessionSummaries } from "../../session/events.js";
import { readInteractiveLine } from "../prompt/interactivePrompt.js";
import type { SlashCommand } from "../prompt/slashMenu.js";
import { printSessionSummaries, sessionsCommand } from "./sessions.js";
import { resumeCommand } from "./resume.js";

const SLASH_COMMANDS: SlashCommand[] = [
  // chat 模式支持的内置命令；交互式菜单和 readline completer 共用这份列表。
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear the terminal", category: "system" },
  { name: "/context", description: "Print the current ProjectContext summary", category: "system" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "List previous sessions in this project", category: "session" },
  { name: "/permissions", description: "View or change permission mode", category: "system" },
  { name: "/approvals", description: "Alias for /permissions", category: "system" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit chat", category: "system" },
  { name: "/quit", description: "Exit chat", category: "system" }
];

export async function chatCommand(workspaceRoot: string): Promise<void> {
  // chat 复用标准命令运行时，确保配置、session 和工具注册与 run 命令一致。
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    await runChatLoop(runtime);
  });
}

async function runChatLoop(runtime: CommandRuntime): Promise<void> {
  console.log(`Session: ${runtime.recorder.filePath}`);
  console.log("输入 / 查看命令。使用 ↑/↓ 选择，Enter 确认，Tab 补全，输入 /exit 退出。");
  if (input.isTTY && output.isTTY) {
    // TTY 环境使用自定义 raw mode 输入，以支持上下键选择 slash 菜单。
    while (true) {
      const line = await readInteractiveLine("> ", SLASH_COMMANDS);
      if (line === undefined) break;
      const shouldContinue = await handleInputLine(runtime, line);
      if (!shouldContinue) break;
    }
    return;
  }

  // 非 TTY 环境退回 readline，适合管道输入或简单终端环境。
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
  // 普通文本交给 agent loop；loop 会按 intent 决定是否调用工具或直接问答。
  const result = await runAgentTask(text, runtime);
  console.log(result);
  return true;
}

async function handleSlashCommand(runtime: CommandRuntime, text: string): Promise<boolean> {
  // slash command 用空白拆分，命令本身固定在第一个 token。
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

  if (command === "/permissions" || command === "/approvals") {
    console.log(runPermissionCommand(runtime.permissionManager, args));
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
    // chat 内的 /plan 不调用工具，只把通用执行计划写入当前 session。
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
      "- Provider output should be reviewed before executing changes.",
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
  // readline completer 只用于非 raw-mode 分支；raw-mode 下由 prompt 模块处理补全。
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS.map((command) => command.name).filter((command) => command.startsWith(line));
  return [hits.length ? hits : SLASH_COMMANDS.map((command) => command.name), line];
}

function printSlashHelp(): void {
  // 帮助文本直接来自命令表，避免菜单和 help 内容漂移。
  console.log("Available commands:");
  for (const command of SLASH_COMMANDS) {
    console.log(`  ${command.name.padEnd(16)}${command.description}`);
  }
}
