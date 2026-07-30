/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import type { AgentTurnOutcome } from "../../agent/types.js";
import type { CommandRuntime } from "../../runtime/CommandRuntime.js";
import type { SessionLease, SessionLeaseStore } from "../../runtime/SessionLease.js";
import { withCliAbortSignal } from "../sigint.js";

export async function runCommand(workspaceRoot: string, input: string): Promise<void> {
  const [{ createCommandRuntime }, { ExecutionService }, { SessionLeaseStore }] = await Promise.all([
    import("../../runtime/CommandRuntime.js"),
    import("../../runtime/ExecutionService.js"),
    import("../../runtime/SessionLease.js")
  ]);
  let runtime: CommandRuntime | undefined;
  let leases: SessionLeaseStore | undefined;
  let lease: SessionLease | undefined;
  try {
    runtime = await createCommandRuntime(workspaceRoot);
    leases = await SessionLeaseStore.open(runtime.persistenceRoot);
    lease = leases.acquire(runtime.agent.getInfo().sessionId);
    const execution = await ExecutionService.create(runtime);
    const result = await withCliAbortSignal(async (signal) => await execution.execute({ input, signal }));
    if (result.turn.output) console.log(result.turn.output);
    console.log(`\nSession: ${result.session.sessionFile}`);
    assertCompletedCliRun(result.turn);
  } catch (error) {
    runtime?.agent.recordError(error);
    throw error;
  } finally {
    try {
      await runtime?.close();
    } finally {
      lease?.close();
      leases?.close();
    }
  }
}

/** Throwing here lets the CLI composition root set a non-zero exit status. */
export function assertCompletedCliRun(outcome: AgentTurnOutcome): void {
  if (outcome.status === "completed" && outcome.stopReason === "model_stop") return;
  const detail = outcome.error ?? `Agent task stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`;
  throw new Error(`Agent task ${outcome.status}: ${detail}`);
}
