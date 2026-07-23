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

/** Converts raw runtime observations into durable, lineage-aware evidence. */
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

export function attachCleanupLineage(evidence: TaskEvidence[], parentEvidenceIds: string[]): TaskEvidence[] {
  return evidence.map((item) => ({
    ...item,
    parentEvidenceIds: [...new Set([...item.parentEvidenceIds, ...parentEvidenceIds])]
  }));
}

function agentOutcomeEvidence(attempt: AttemptEvidenceSource): TaskEvidence {
  const passed = attempt.status === "completed" && attempt.stopReason === "model_stop";
  return {
    id: `attempt:${attempt.attemptId}:agent:outcome`,
    kind: "agent",
    attemptId: attempt.attemptId,
    parentEvidenceIds: [],
    passed,
    summary: passed
      ? "Agent reached a terminal model stop."
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

function redactRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const redacted = redactSensitiveValue(value);
  return isRecord(redacted) ? redacted : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
