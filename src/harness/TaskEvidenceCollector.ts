/**
 * 任务证据采集。
 *
 * 把运行期的原始观测（Agent 结束状态、每次工具调用、验收结果）转成带血缘关系的证据条目：
 * `id` 是可复现的，`parentEvidenceIds` 记录「这条证据由哪些证据推导而来」，便于回溯为什么
 * 判定通过或失败。
 *
 * 证据会落盘，所以 details 一律先做敏感信息脱敏。
 */
import { redactSensitiveValue } from "../utils/secrets.js";
import type { AcceptanceEvidence, TaskEvidence, TaskToolEvidence } from "./types.js";

export interface AttemptEvidenceSource {
  attemptId: string;
  status: string;
  stopReason?: string;
  finishReason?: string;
  runtimeSteps: number;
  endedAt?: string;
  toolEvidence: TaskToolEvidence[];
}

/** 一次尝试的证据 = Agent 结束状态一条 + 每次工具调用一条。 */
export function collectAttemptEvidence(attempt: AttemptEvidenceSource): TaskEvidence[] {
  return [agentOutcomeEvidence(attempt), ...attempt.toolEvidence.map((evidence) => toolEvidence(attempt.attemptId, evidence))];
}

export function collectVerificationEvidence(
  attemptId: string,
  evidence: AcceptanceEvidence[],
  parentEvidenceIds: string[]
): TaskEvidence[] {
  return evidence.map((item) => ({
    id: `attempt:${attemptId}:verification:${item.criterionId}`,
    kind: "verification",
    attemptId,
    parentEvidenceIds: [...parentEvidenceIds],
    passed: item.passed,
    summary: item.summary,
    observedAt: item.observedAt,
    details: item.details === undefined ? undefined : redactRecord(item.details)
  }));
}

export function toolEvidenceId(attemptId: string, evidence: TaskToolEvidence): string {
  return `attempt:${attemptId}:tool:${evidence.toolCallId}`;
}

/** 给清理证据补上父级血缘；用 Set 去重，避免多次挂接同一父证据。 */
export function attachCleanupLineage(evidence: TaskEvidence[], parentEvidenceIds: string[]): TaskEvidence[] {
  return evidence.map((item) => ({
    ...item,
    parentEvidenceIds: [...new Set([...item.parentEvidenceIds, ...parentEvidenceIds])]
  }));
}

function agentOutcomeEvidence(attempt: AttemptEvidenceSource): TaskEvidence {
  // 新运行必须经过 Completion Gate；model_stop 仅供旧 TaskRun 记录兼容。
  const passed = attempt.status === "completed"
    && (attempt.stopReason === "completion_gate" || attempt.stopReason === "model_stop");
  return {
    id: `attempt:${attempt.attemptId}:agent:outcome`,
    kind: "agent",
    attemptId: attempt.attemptId,
    parentEvidenceIds: [],
    passed,
    summary: passed
      ? "Agent reached an approved terminal state."
      : `Agent attempt ended as ${attempt.status} (${attempt.stopReason ?? "unknown"}).`,
    observedAt: attempt.endedAt ?? new Date().toISOString(),
    details: {
      status: attempt.status,
      stopReason: attempt.stopReason,
      finishReason: attempt.finishReason,
      runtimeSteps: attempt.runtimeSteps
    }
  };
}

function toolEvidence(attemptId: string, evidence: TaskToolEvidence): TaskEvidence {
  return {
    id: toolEvidenceId(attemptId, evidence),
    kind: "tool",
    attemptId,
    parentEvidenceIds: [],
    passed: evidence.error === undefined,
    summary: evidence.error === undefined ? `Tool ${evidence.tool} completed.` : `Tool ${evidence.tool} failed: ${evidence.error}`,
    observedAt: evidence.observedAt,
    details: redactRecord({ tool: evidence.tool, args: evidence.args, result: evidence.result, error: evidence.error })
  };
}

/** 脱敏后若不再是对象（例如整体被替换成占位串），宁可不写 details。 */
function redactRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const redacted = redactSensitiveValue(value);
  return isRecord(redacted) ? redacted : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
