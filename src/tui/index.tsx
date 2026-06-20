import React from "react";
import { render } from "ink";
import path from "node:path";
import { App, type TuiExitSummary } from "./App.js";

export async function startTui(workspaceRoot: string): Promise<void> {
  let exitSummary: TuiExitSummary | undefined;
  const instance = render(<App workspaceRoot={workspaceRoot} onExitSummary={(summary) => {
    exitSummary = summary;
  }} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  clearTerminal();
  if (exitSummary) {
    const relativeSessionFile = path.relative(workspaceRoot, exitSummary.sessionFile);
    process.stdout.write([
      `Session: ${exitSummary.sessionId}`,
      `File: ${relativeSessionFile}`,
      "",
      "Resume:",
      `  pnpm dev -- tui`,
      `  /resume ${exitSummary.sessionId}`,
      ""
    ].join("\n"));
  }
}

function clearTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
