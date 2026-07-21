/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import { createInteractiveAgentRuntime } from "../../runtime/InteractiveAgentRuntime.js";
import type { AgentTurnOutcome } from "../../agent/types.js";
import { withCliAbortSignal } from "../sigint.js";

export async function runCommand(workspaceRoot: string, input: string): Promise<void> {
  // run 是一次性入口：执行完一个任务后输出结果和 session 文件位置。
  const runtime = await createInteractiveAgentRuntime(workspaceRoot);
  try {
    const outcome = await withCliAbortSignal(async (abortSignal) => {
      const submitted = runtime.submitPrompt(input);
      const onAbort = (): void => {
        runtime.cancelRun(submitted.runId);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      try {
        return await submitted.completion;
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
      }
    });
    if (outcome.output) console.log(outcome.output);
    console.log(`\nSession: ${runtime.getInfo().sessionFile}`);
    assertCompletedCliRun(outcome);
  } finally {
    await runtime.close();
  }
}

/** Throwing here lets the CLI composition root set a non-zero exit status. */
export function assertCompletedCliRun(outcome: AgentTurnOutcome): void {
  if (outcome.status === "completed" && outcome.stopReason === "model_stop") return;
  const detail = outcome.error ?? `Agent task stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`;
  throw new Error(`Agent task ${outcome.status}: ${detail}`);
}
