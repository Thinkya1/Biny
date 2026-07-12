/**
 * TUI slash command 清单模块。
 *
 * TUI 输入框通过这份列表展示命令菜单、补全命令名并判断命令是否需要参数。
 * 命令的具体行为仍在 App 中分发处理。
 */
import type { SlashCommand } from "../cli/prompt/slashMenu.js";

// TUI 和普通 chat 使用相同 SlashCommand 结构，但描述按 TUI 行为调整。
export const TUI_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear visible messages", category: "system" },
  { name: "/context", description: "Show loaded context and budget", category: "system" },
  { name: "/compact", description: "Compact older conversation history", category: "system" },
  { name: "/model", description: "Switch model and thinking effort", category: "system" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "Show a session, defaults to latest", category: "session" },
  { name: "/permissions", description: "View or change permission mode", category: "system" },
  { name: "/approvals", description: "Alias for /permissions", category: "system" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit TUI", category: "system" },
  { name: "/quit", description: "Exit TUI", category: "system" }
];
