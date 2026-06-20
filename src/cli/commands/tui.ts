export async function tuiCommand(workspaceRoot: string): Promise<void> {
  // Ink 只在真正启动 TUI 时加载，避免普通 run/chat 命令被 TUI 依赖的终端初始化影响。
  const { startTui } = await import("../../tui/index.js");
  await startTui(workspaceRoot);
}
