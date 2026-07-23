import type { SessionUsage } from "../session/metadata.js";
import type { AgentTurnStopReason } from "../agent/types.js";

export type TaskVerificationMode = "model_only" | "deterministic";

export type TaskType = "conversation" | "code_change" | "launch";
export type TaskPlanStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type TaskCleanupPolicy = "not_needed" | "stop_task_processes" | "preserve_task_processes";
export type TaskCleanupStatus = "pending" | "not_needed" | "preserved" | "completed" | "failed";

/** The Task Compiler's sole durable description of task intent and state. */
export interface TaskContract {
  objective: string;
  taskType: TaskType;
  constraints: string[];
  artifacts: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  verificationMode: TaskVerificationMode;
  plan: TaskPlanItem[];
  cleanup: TaskCleanupPlan;
  pendingTodo: string[];
}

export interface TaskPlanItem {
  id: string;
  description: string;
  required: boolean;
  status: TaskPlanStatus;
  evidenceIds: string[];
  updatedAt?: string;
}

export interface TaskCleanupPlan {
  policy: TaskCleanupPolicy;
  status: TaskCleanupStatus;
  processIds: string[];
  evidenceIds: string[];
  summary?: string;
  completedAt?: string;
}

export type AcceptanceCriterion =
  | {
    id: string;
    kind: "file_exists";
    path: string;
    description?: string;
  }
  | {
    id: string;
    kind: "workspace_changed";
    baselineDigest: string;
    description?: string;
  }
  | {
    id: string;
    kind: "command_succeeded";
    /** Exact command the independent verifier executes. */
    command: string;
    cwd?: string;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "http";
    url: string;
    expectedStatus?: number;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "tcp";
    host: string;
    port: number;
    timeoutMs?: number;
    description?: string;
  }
  | {
    id: string;
    kind: "managed_process";
    processId?: string;
    url?: string;
    cwd?: string;
    requireHttpReadiness?: boolean;
    description?: string;
  };

export interface TaskToolEvidence {
  toolCallId: string;
  tool: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  observedAt: string;
}

export interface AcceptanceEvidence {
  criterionId: string;
  passed: boolean;
  summary: string;
  observedAt: string;
  details?: Record<string, unknown>;
}

/** Immutable, lineage-aware view over tool, verifier, and cleanup evidence. */
export interface TaskEvidence {
  id: string;
  kind: "agent" | "tool" | "verification" | "cleanup";
  attemptId?: string;
  parentEvidenceIds: string[];
  passed?: boolean;
  summary: string;
  observedAt: string;
  details?: Record<string, unknown>;
}

export interface TaskCleanupResult {
  cleanup: TaskCleanupPlan;
  evidence: TaskEvidence[];
  passed: boolean;
  summary: string;
}

export interface AgentAttemptExecution {
  output: string;
  runtimeSteps: number;
  usage?: SessionUsage;
  outcomeStatus: "completed" | "incomplete" | "failed" | "aborted";
  stopReason: AgentTurnStopReason;
  finishReason?: string;
  error?: string;
  /** Evidence produced by only this attempt, for durable per-attempt audit. */
  attemptToolEvidence: TaskToolEvidence[];
  /** Evidence accumulated across automatic continuations for verification. */
  toolEvidence: TaskToolEvidence[];
}
