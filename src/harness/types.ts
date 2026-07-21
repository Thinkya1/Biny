import type { SessionUsage } from "../session/metadata.js";
import type { AgentTurnStopReason } from "../agent/types.js";

/** A durable, product-level task rather than a single model turn. */
export interface TaskRequest {
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  pendingTodo?: string[];
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
    kind: "command_succeeded";
    /** Exact command or a regular expression matched against observed run_command calls. */
    command?: string;
    commandPattern?: string;
    cwd?: string;
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
    commandPattern?: string;
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
