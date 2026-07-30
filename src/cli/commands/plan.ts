/**
 * 计划命令模块。
 *
 * CLI 只负责启动共享 runtime；计划消息的上下文组装和记录由 AgentSession 处理。
 */
import { createInteractiveAgentHost } from "../../runtime/InteractiveAgentRuntime.js";
import { withCliAbortSignal } from "../sigint.js";

export async function planCommand(workspaceRoot: string, task: string): Promise<void> {
  const { runtime } = await createInteractiveAgentHost(workspaceRoot);
  try {
    const outcome = await withCliAbortSignal(async (signal) => {
      const submitted = runtime.submitPrompt(task, "plan");
      const onAbort = (): void => {
        runtime.cancelRun(submitted.runId);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await submitted.completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    if (outcome.output) console.log(outcome.output);
    if (outcome.status !== "completed") {
      throw new Error(outcome.error ?? `Plan stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`);
    }
    console.log(`\nSession: ${runtime.getSnapshot().info.sessionFile}`);
  } finally {
    await runtime.close();
  }
}
