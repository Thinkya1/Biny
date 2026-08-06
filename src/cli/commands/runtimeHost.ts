/** 手动启动独立 Runtime Host；Desktop/TUI 通常会在需要时自动拉起它。 */
import { runRuntimeHostProcess } from "../../runtime/hostProcess.js";

export async function runtimeHostCommand(): Promise<void> {
  const commandIndex = process.argv.lastIndexOf("runtime-host");
  await runRuntimeHostProcess(commandIndex < 0 ? [] : process.argv.slice(commandIndex + 1));
}
