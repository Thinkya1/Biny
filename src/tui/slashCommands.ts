import type { SlashCommand } from "../cli/prompt/slashMenu.js";

export const TUI_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear visible messages", category: "system" },
  { name: "/context", description: "Show current ProjectContext", category: "system" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "Show a session, defaults to latest", category: "session" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit TUI", category: "system" },
  { name: "/quit", description: "Exit TUI", category: "system" }
];
