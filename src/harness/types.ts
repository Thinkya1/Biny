/**
 * Task harness 共享类型。
 *
 * 契约、计划项、验收条件、证据和一次尝试的执行结果都在这里定义。harness 的各个模块
 * （编译契约、执行尝试、独立验收、清理、落盘）只通过这些类型交互。
 */
import type { SessionUsage } from "../session/metadata.js";
import type { AgentTurnStopReason } from "../agent/types.js";

export type TaskVerificationMode = "model_only" | "deterministic";

export type TaskType = "conversation" | "code_change" | "launch";
export type TaskPlanStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type TaskCleanupPolicy = "not_needed" | "stop_task_processes" | "preserve_task_processes";
export type TaskCleanupStatus = "pending" | "not_needed" | "preserved" | "completed" | "failed";

/** 任务意图与状态的唯一持久化描述，由 Task Compiler 生成。 */
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

/**
 * 验收条件。每一项都必须能被独立验收器机器化检查，因此参数写死在条件里（命令、路径、
 * URL 等），不依赖 Agent 的说法。
 */
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
    /** 独立验收器实际执行的命令，原样运行。 */
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

/** 工具、验收和清理证据的统一形状：不可变，并通过 `parentEvidenceIds` 记录推导关系。 */
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
  /** 只属于本次尝试的证据，用于按尝试留档审计。 */
  attemptToolEvidence: TaskToolEvidence[];
  /** 跨自动续跑累积的证据，验收时看的是这一份。 */
  toolEvidence: TaskToolEvidence[];
}
