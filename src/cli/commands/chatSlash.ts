import type { CommandRuntime } from "../../runtime/CommandRuntime.js";
import { parseThinkingSelection } from "../../llm/ModelManager.js";
import { formatSubagentTaskReport } from "../../runtime/subagentTaskReport.js";
import type { SlashCommand } from "../prompt/slashMenu.js";
import { printSessionSummaries } from "./sessions.js";

export const CHAT_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear the terminal", category: "system" },
  { name: "/context", description: "Show loaded context and budget", category: "system" },
  { name: "/usage", description: "Show SDK token usage and cost", category: "system" },
  { name: "/compact", description: "Compact older conversation history", category: "system" },
  { name: "/model", description: "Switch model and thinking effort", category: "system" },
  { name: "/status", description: "Show model, permissions and extensions", category: "system" },
  { name: "/mcp", description: "List configured MCP servers and tools", category: "extension" },
  { name: "/skills", description: "List loaded workspace skills", category: "extension" },
  { name: "/plugins", description: "List loaded plugins", category: "extension" },
  { name: "/subagent", description: "Run or manage a read-only subagent (start/status/cancel)", category: "extension", requiresArgs: true },
  { name: "/review", description: "Review current changes with a read-only subagent", category: "extension" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "Continue a previous session", category: "session" },
  { name: "/permissions", description: "View or change permission mode", category: "system" },
  { name: "/approvals", description: "Alias for /permissions", category: "system" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit chat", category: "system" },
  { name: "/quit", description: "Exit chat", category: "system" }
];

export async function executeChatSlashCommand(runtime: CommandRuntime, text: string, signal?: AbortSignal): Promise<boolean> {
  const agent = runtime.agent;
  const [command, ...args] = text.split(/\s+/);

  if (command === "/" || command === "/help") {
    printSlashHelp();
    return true;
  }
  if (command === "/exit" || command === "/quit") return false;
  if (command === "/clear") {
    console.clear();
    return true;
  }
  if (command === "/context") {
    console.log(await agent.contextReport());
    return true;
  }
  if (command === "/usage") {
    console.log(agent.usageReport());
    return true;
  }
  if (command === "/status") {
    console.log(`Model: ${agent.getInfo().modelLabel} (${agent.getInfo().reasoningLabel})`);
    console.log(`Permissions: ${agent.getPermissionMode()}`);
    console.log(runtime.extensionReport());
    return true;
  }
  if (command === "/mcp") {
    console.log(runtime.extensionReport("mcp"));
    return true;
  }
  if (command === "/skills") {
    console.log(runtime.extensionReport("skills"));
    return true;
  }
  if (command === "/plugins") {
    console.log(runtime.extensionReport("plugins"));
    return true;
  }
  if (command === "/subagent") {
    const action = args[0]?.toLowerCase();
    if (action === "start") {
      const task = args.slice(1).join(" ").trim();
      if (!task) {
        console.log("Usage: /subagent start <read-only task>");
        return true;
      }
      const submitted = runtime.startSubagentTask(task);
      console.log(`Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
      return true;
    }
    if (action === "status") {
      console.log(formatSubagentTaskReport(runtime.listSubagentTasks()));
      return true;
    }
    if (action === "cancel") {
      const taskId = args[1]?.trim();
      if (!taskId) {
        console.log("Usage: /subagent cancel <task-id>");
        return true;
      }
      const cancelled = runtime.cancelSubagentTask(taskId, "Cancelled from the CLI.");
      console.log(cancelled ? `Cancelled subagent task ${taskId}.` : `No active subagent task found for ${taskId}.`);
      return true;
    }
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id>");
      return true;
    }
    console.log(await runtime.runSubagentTask(task, { signal }));
    return true;
  }
  if (command === "/review") {
    const instructions = args.join(" ").trim();
    const task = instructions || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    console.log(await runtime.runSubagentTask(task, { signal }));
    return true;
  }
  if (command === "/compact") {
    console.log(await agent.compactConversation(args.join(" ").trim() || undefined, signal));
    return true;
  }
  if (command === "/model") {
    if (!args[0]) {
      const info = agent.getInfo();
      console.log(`Current model: ${info.modelLabel}`);
      console.log(`Thinking: ${info.reasoningLabel}`);
      console.log("Available models:");
      for (const model of agent.listModels()) {
        const current = model.alias === info.modelAlias ? " <- current" : "";
        console.log(`  ${model.alias.padEnd(24)}${model.provider}  ${model.efforts.join("/") || "no thinking"}${current}`);
      }
      console.log("Usage: /model <alias> [off|high|max]");
      return true;
    }
    const info = await agent.switchModel(args[0], parseThinkingSelection(args[1]));
    console.log(`Switched model: ${info.modelLabel} (thinking: ${info.reasoningLabel})`);
    return true;
  }
  if (command === "/sessions") {
    printSessionSummaries(await agent.listSessions());
    return true;
  }
  if (command === "/permissions" || command === "/approvals") {
    console.log(await agent.runPermissionCommand(args));
    return true;
  }
  if (command === "/resume") {
    if (!args[0]) {
      printSessionSummaries(await agent.listSessions());
      return true;
    }
    const resumed = await agent.resume(args[0]);
    console.log(`Resumed session: ${resumed.filePath}`);
    return true;
  }
  if (command === "/plan") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Usage: /plan <task>");
      return true;
    }
    console.log(await agent.createPlan(task, undefined, signal));
    return true;
  }

  console.log(`Unknown command: ${command}`);
  printSlashHelp();
  return true;
}

export function completeChatSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const names = CHAT_SLASH_COMMANDS.map((command) => command.name);
  const hits = names.filter((command) => command.startsWith(line));
  return [hits.length ? hits : names, line];
}

function printSlashHelp(): void {
  console.log("Available commands:");
  for (const command of CHAT_SLASH_COMMANDS) console.log(`  ${command.name.padEnd(16)}${command.description}`);
}
