/**
 * TUI 启动模块。
 *
 * 这里调用 Ink `render` 挂载顶层 App，并在界面退出后打印当前 session id 和恢复提示。
 * 这样 TUI 的交互输出不会和退出后的普通命令行信息混在一起。
 */
import React from "react";
import { render } from "ink";
import path from "node:path";
import { App, type TuiExitSummary } from "./App.js";

export async function startTui(workspaceRoot: string): Promise<void> {
  // Ink 退出后再打印 session 摘要，避免和 TUI 布局混在一起。
  let exitSummary: TuiExitSummary | undefined;
  const instance = render(<App workspaceRoot={workspaceRoot} onExitSummary={(summary) => {
    exitSummary = summary;
  }} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  if (exitSummary) {
    const relativeSessionFile = path.relative(workspaceRoot, exitSummary.sessionFile);
    process.stdout.write([
      `Session: ${exitSummary.sessionId}`,
      `File: ${relativeSessionFile}`,
      "",
      "Resume:",
      `  biny`,
      `  /resume ${exitSummary.sessionId}`,
      ""
    ].join("\n"));
  }
}
