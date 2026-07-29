/**
 * TUI 启动模块。
 *
 * 创建终端和 pi-tui 渲染循环，交给 `BinyTui` 组装界面；界面退出后再打印 session
 * 摘要，避免和 TUI 输出混在一起。
 */
import path from "node:path";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { BinyTui } from "./app.js";

export async function startTui(workspaceRoot: string, version?: string, initialSession?: string): Promise<void> {
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  const app = new BinyTui(ui, workspaceRoot, version, initialSession);

  const onSignal = (): void => {
    void app.exit();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let summary: { sessionId: string; sessionFile: string } | undefined;
  try {
    summary = await app.run();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (summary) {
    const relativeSessionFile = path.relative(workspaceRoot, summary.sessionFile);
    process.stdout.write([
      `Session: ${summary.sessionId}`,
      `File: ${relativeSessionFile}`,
      "",
      "Resume:",
      "  biny",
      `  /resume ${summary.sessionId}`,
      ""
    ].join("\n"));
  }
}
