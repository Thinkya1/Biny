/**
 * 任务重试与终局判定策略。
 *
 * 单独成文件是为了让「要不要再试一次」「算不算做完」这两个判断可以独立测试，不和 Agent
 * 执行循环、验收循环缠在一起。这里是纯函数，不读文件也不发请求。
 */
import type { AgentAttemptExecution, TaskCleanupPlan, TaskContract, TaskPlanItem } from "./types.js";
import type { TaskHarnessDecision, TaskVerification } from "./TaskAttemptLoop.js";
import { requiredPlanFailures } from "./TaskPlanner.js";

export interface TaskTerminalDecision {
  passed: boolean;
  summary: string;
}

/**
 * 决定一次尝试之后怎么走。判断顺序即优先级：
 * 用户中断 → 直接放弃；被内容过滤拦下 → 重试也是同样结果，停；没有可用运行配置且没跑完 →
 * 环境问题，重试无意义。其余情况才允许重试。
 */
export function decideTaskAttempt(
  execution: AgentAttemptExecution | undefined,
  hasRuntimeConfig: boolean
): TaskHarnessDecision {
  if (execution?.outcomeStatus === "aborted") return "abort";
  if (execution?.stopReason === "content_filter") return "stop";
  if (!hasRuntimeConfig && execution?.outcomeStatus !== "completed") return "stop";
  return "retry";
}

/**
 * 终局判定：验收通过、必做计划项完成、清理有据可查，三者齐了才算做完。
 * 没有契约/计划/清理信息时（轻量任务）只看验收结果。
 */
export function judgeTaskTerminal(
  contract: TaskContract | undefined,
  verification: TaskVerification,
  plan: TaskPlanItem[] | undefined,
  cleanup: TaskCleanupPlan | undefined
): TaskTerminalDecision {
  if (!verification.passed) return { passed: false, summary: verification.summary };
  if (!contract || !plan || !cleanup) return { passed: true, summary: verification.summary };
  const pending = requiredPlanFailures(plan);
  if (pending.length) {
    return {
      passed: false,
      summary: `Required plan items are not complete: ${pending.map((item) => item.description).join("; ")}`
    };
  }
  if (cleanup.status === "failed" || cleanup.status === "pending") {
    return { passed: false, summary: cleanup.summary ?? "Task cleanup is not complete." };
  }
  return { passed: true, summary: verification.summary };
}
