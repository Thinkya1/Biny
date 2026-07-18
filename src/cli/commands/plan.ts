/**
 * 计划命令模块。
 *
 * CLI 只负责启动共享 runtime；计划消息的上下文组装和记录由 AgentSession 处理。
 */
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";
import { withCliAbortSignal } from "../sigint.js";

export async function planCommand(workspaceRoot: string, task: string): Promise<void> {
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    const output = await withCliAbortSignal(async (signal) => await runtime.agent.createPlan(task, undefined, signal));
    console.log(output);
    console.log(`\nSession: ${runtime.agent.getInfo().sessionFile}`);
  });
}
