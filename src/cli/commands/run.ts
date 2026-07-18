/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";
import { withCliAbortSignal } from "../sigint.js";

export async function runCommand(workspaceRoot: string, input: string): Promise<void> {
  // run 是一次性入口：执行完一个任务后输出结果和 session 文件位置。
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    const output = await withCliAbortSignal(async (abortSignal) => await runtime.agent.runTask(input, { abortSignal }));
    console.log(output);
    console.log(`\nSession: ${runtime.agent.getInfo().sessionFile}`);
  });
}
