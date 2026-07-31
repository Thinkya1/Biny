/** Desktop 与 TUI 共用的 slash command 声明。 */
export type CommandSurface = "tui" | "desktop";

export interface SlashCommandDefinition {
  name: string;
  description: string;
  category: string;
  requiresArgs?: boolean;
  acceptsArgs?: boolean;
  surfaces: readonly CommandSurface[];
}

const terminalOnly = ["tui"] as const;
const allInteractive = ["tui", "desktop"] as const;

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: "/help", description: "Show available commands", category: "system", surfaces: terminalOnly },
  { name: "/clear", description: "Clear visible messages", category: "system", surfaces: terminalOnly },
  { name: "/context", description: "Show loaded context and budget", category: "system", surfaces: allInteractive },
  { name: "/usage", description: "Show SDK token usage and cost", category: "system", surfaces: allInteractive },
  { name: "/compact", description: "Compact older conversation history", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/model", description: "Choose a model and its supported thinking effort", category: "system", surfaces: terminalOnly },
  { name: "/status", description: "Show model, permissions and extensions", category: "system", surfaces: allInteractive },
  { name: "/mcp", description: "List MCP servers and tools, or reconnect a server", category: "extension", acceptsArgs: true, surfaces: allInteractive },
  { name: "/skills", description: "List available project and global skills", category: "extension", surfaces: allInteractive },
  { name: "/plugins", description: "List loaded plugins", category: "extension", surfaces: allInteractive },
  { name: "/subagent", description: "Run or manage a subagent (start/status/cancel/agents)", category: "extension", requiresArgs: true, acceptsArgs: true, surfaces: allInteractive },
  { name: "/review", description: "Review current changes with a read-only subagent", category: "extension", acceptsArgs: true, surfaces: allInteractive },
  { name: "/memory", description: "Manage durable project memory (list/show/add/forget/search/compact)", category: "extension", acceptsArgs: true, surfaces: allInteractive },
  { name: "/sessions", description: "List recorded sessions", category: "session", surfaces: terminalOnly },
  { name: "/resume", description: "Resume a session, defaults to latest", category: "session", surfaces: terminalOnly },
  { name: "/permissions", description: "View or change permission mode", category: "system", surfaces: terminalOnly },
  { name: "/approvals", description: "Alias for /permissions", category: "system", surfaces: terminalOnly },
  { name: "/undo", description: "Restore the workspace from a Biny checkpoint", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/continue", description: "Resume an interrupted, blocked, or resumable incomplete turn", category: "system", surfaces: allInteractive },
  { name: "/fork", description: "Fork a session into a new one", category: "session", surfaces: terminalOnly },
  { name: "/plan", description: "Toggle Plan mode or plan the next task", category: "plan", surfaces: terminalOnly },
  { name: "/mode", description: "Choose Chat or read-only Plan mode", category: "plan", surfaces: terminalOnly },
  { name: "/exit", description: "Exit Biny", category: "system", surfaces: terminalOnly },
  { name: "/quit", description: "Exit Biny", category: "system", surfaces: terminalOnly }
];

export function slashCommandsForSurface(surface: CommandSurface): SlashCommandDefinition[] {
  return SLASH_COMMANDS.filter((command) => command.surfaces.includes(surface));
}
