/**
 * 交互式 chat 命令模块。
 *
 * 这里仅维护终端输入循环；slash 语义、session 恢复和上下文操作分别交给专用命令与 runtime 模块。
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { CommandRuntime } from "../../runtime/CommandRuntime.js";
import { createCommandRuntime } from "../../runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../../runtime/InteractiveAgentRuntime.js";
import { RootRunLedger } from "../../runtime/RootRunLedger.js";
import { readInteractiveLine } from "../prompt/interactivePrompt.js";
import { withCliAbortSignal } from "../sigint.js";
import { CHAT_SLASH_COMMANDS, completeChatSlashCommand, executeChatSlashCommand } from "./chatSlash.js";

export interface ChatCommandOptions {
  continue?: boolean;
  session?: string;
}

export async function chatCommand(workspaceRoot: string, options: ChatCommandOptions = {}): Promise<void> {
  if (options.continue && options.session) throw new Error("Use either --continue or --session <id>, not both.");

  const runtime = await createCommandRuntime(workspaceRoot);
  let ledger: RootRunLedger;
  try {
    ledger = await RootRunLedger.open(runtime.persistenceRoot);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const host = new InteractiveAgentRuntime(runtime, { runLedger: ledger, taskRunStore: runtime.taskRuns });
  try {
    if (options.continue || options.session) {
      const resumed = await runtime.agent.resume(options.session);
      console.log(`Resumed: ${resumed.filePath}`);
    }
    await runChatLoop(runtime, host);
  } finally {
    await host.close();
  }
}

async function runChatLoop(runtime: CommandRuntime, host: InteractiveAgentRuntime): Promise<void> {
  const agent = runtime.agent;
  console.log(`Session: ${agent.getInfo().sessionFile}`);
  console.log("输入 / 查看命令。使用 ↑/↓ 选择，Enter 确认，Tab 补全，输入 /exit 退出。");
  if (input.isTTY && output.isTTY) {
    while (true) {
      const line = await readInteractiveLine("> ", CHAT_SLASH_COMMANDS);
      if (line === undefined) break;
      if (!await handleInputLine(runtime, host, line)) break;
    }
    return;
  }

  const readline = createInterface({ input, output, completer: completeChatSlashCommand, prompt: "> " });
  try {
    if (output.isTTY) readline.prompt();
    for await (const line of readline) {
      if (!await handleInputLine(runtime, host, line)) break;
      if (output.isTTY) readline.prompt();
    }
  } finally {
    readline.close();
  }
}

async function handleInputLine(runtime: CommandRuntime, host: InteractiveAgentRuntime, line: string): Promise<boolean> {
  const text = line.trim();
  if (!text) return true;
  try {
    return await withCliAbortSignal(async (signal) => {
      if (text.startsWith("/")) return await executeChatSlashCommand(runtime, text, signal);
      const submitted = host.submitPrompt(text);
      const onAbort = (): void => {
        host.cancelRun(submitted.runId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const outcome = await submitted.completion.finally(() => signal.removeEventListener("abort", onAbort));
      if (outcome.output) console.log(outcome.output);
      if (outcome.status !== "completed") {
        process.exitCode = 1;
        console.error(outcome.error ?? `Agent turn ${outcome.status}: ${outcome.stopReason} after ${String(outcome.steps)} steps.`);
      }
      return true;
    });
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
    return true;
  }
}
