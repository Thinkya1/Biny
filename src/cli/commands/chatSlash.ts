import type { AgentSession } from "../../agent/AgentSession.js";
import { parseThinkingSelection } from "../../llm/ModelManager.js";
import type { SlashCommand } from "../prompt/slashMenu.js";
import { printSessionSummaries } from "./sessions.js";

export const CHAT_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear the terminal", category: "system" },
  { name: "/context", description: "Show loaded context and budget", category: "system" },
  { name: "/compact", description: "Compact older conversation history", category: "system" },
  { name: "/model", description: "Switch model and thinking effort", category: "system" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "Continue a previous session", category: "session" },
  { name: "/permissions", description: "View or change permission mode", category: "system" },
  { name: "/approvals", description: "Alias for /permissions", category: "system" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit chat", category: "system" },
  { name: "/quit", description: "Exit chat", category: "system" }
];

export async function executeChatSlashCommand(agent: AgentSession, text: string): Promise<boolean> {
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
  if (command === "/compact") {
    console.log(await agent.compactConversation(args.join(" ").trim() || undefined));
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
    console.log(await agent.createPlan(task));
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
