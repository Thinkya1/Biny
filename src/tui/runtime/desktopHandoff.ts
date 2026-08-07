/**
 * TUI 到 Desktop 的显式会话交接。
 *
 * 交接只负责唤起桌面端并携带 workspace/session 标识，不启动模型、不续跑 turn。
 * Desktop 主进程收到参数后再通过自己的 IPC 边界打开会话正文。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openDesktopSession(workspaceRoot: string, sessionId: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("`/app` currently requires macOS Biny Desktop.");
  const applicationName = process.env.BINY_DESKTOP_APP?.trim() || "Biny";
  await execFileAsync("/usr/bin/open", [
    "-a",
    applicationName,
    "--args",
    "--biny-workspace",
    path.resolve(workspaceRoot),
    "--biny-session",
    sessionId
  ]);
}
