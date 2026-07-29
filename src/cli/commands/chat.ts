/** `biny chat` 是默认 TUI 的兼容别名，不再维护第二套终端交互循环。 */
import { tuiCommand } from "./tui.js";

export interface ChatCommandOptions {
  continue?: boolean;
  session?: string;
}

export async function chatCommand(workspaceRoot: string, options: ChatCommandOptions = {}): Promise<void> {
  if (options.continue && options.session) throw new Error("Use either --continue or --session <id>, not both.");
  await tuiCommand(workspaceRoot, undefined, options.session ?? (options.continue ? "latest" : undefined));
}
