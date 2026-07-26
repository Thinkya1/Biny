/**
 * TUI 命令模块。
 *
 * `tui` 会按需动态加载终端界面入口，避免普通 CLI 命令启动时初始化 TUI 依赖。
 * 真正的界面状态和事件桥接都在 `src/tui` 下实现。
 */
export async function tuiCommand(workspaceRoot: string, version?: string): Promise<void> {
  // 界面框架只在真正启动 TUI 时加载，普通 run/chat 命令不受终端初始化影响。
  const { startTui } = await import("../../tui/index.js");
  await startTui(workspaceRoot, version);
}
