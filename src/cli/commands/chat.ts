/**
 * 交互式 chat 命令模块。
 *
 * 这里仅维护终端输入循环；slash 语义、session 恢复和上下文操作分别交给专用命令与 runtime 模块。
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { CommandRuntime } from "../../runtime/CommandRuntime.js";
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";
import { readInteractiveLine } from "../prompt/interactivePrompt.js";
import { withCliAbortSignal } from "../sigint.js";
import { CHAT_SLASH_COMMANDS, completeChatSlashCommand, executeChatSlashCommand } from "./chatSlash.js";

export interface ChatCommandOptions {
  continue?: boolean;
  session?: string;
}

export async function chatCommand(workspaceRoot: string, options: ChatCommandOptions = {}): Promise<void> {
  if (options.continue && options.session) throw new Error("Use either --continue or --session <id>, not both.");

  await withCommandRuntime(workspaceRoot, async (runtime) => {
    if (options.continue || options.session) {
      const resumed = await runtime.agent.resume(options.session);
      console.log(`Resumed: ${resumed.filePath}`);
    }
    await runChatLoop(runtime);
  });
}

async function runChatLoop(runtime: CommandRuntime): Promise<void> {
  const agent = runtime.agent;
  console.log(`Session: ${agent.getInfo().sessionFile}`);
  console.log("输入 / 查看命令。使用 ↑/↓ 选择，Enter 确认，Tab 补全，输入 /exit 退出。");
  if (input.isTTY && output.isTTY) {
    while (true) {
      const line = await readInteractiveLine("> ", CHAT_SLASH_COMMANDS);
      if (line === undefined) break;
      if (!await handleInputLine(runtime, line)) break;
    }
    return;
  }

  const readline = createInterface({ input, output, completer: completeChatSlashCommand, prompt: "> " });
  try {
    if (output.isTTY) readline.prompt();
    for await (const line of readline) {
      if (!await handleInputLine(runtime, line)) break;
      if (output.isTTY) readline.prompt();
    }
  } finally {
    readline.close();
  }
}

async function handleInputLine(runtime: CommandRuntime, line: string): Promise<boolean> {
  const text = line.trim();
  if (!text) return true;
  try {
    return await withCliAbortSignal(async (signal) => {
      if (text.startsWith("/")) return await executeChatSlashCommand(runtime, text, signal);
      console.log(await runtime.agent.runTask(text, { abortSignal: signal }));
      return true;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return true;
  }
}
