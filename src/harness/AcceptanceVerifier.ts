import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { runShellCommand } from "../tools/shell/runCommand.js";
import { redactSensitiveValue } from "../utils/secrets.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath } from "../workspace/resolvePath.js";
import { workspaceStateDigest } from "./WorkspaceState.js";
import type {
  AcceptanceCriterion,
  AcceptanceEvidence,
  AgentAttemptExecution,
  TaskContract
} from "./types.js";

export interface ManagedProcessInspection {
  processId: string;
  state: string;
  command?: string;
  cwd?: string;
  url?: string;
  readiness?: unknown;
}

export interface ManagedProcessInspector {
  listProcesses(): ManagedProcessInspection[] | Promise<ManagedProcessInspection[]>;
}

export interface AcceptanceVerificationResult {
  passed: boolean;
  summary: string;
  evidence: AcceptanceEvidence[];
}

export interface AcceptanceVerifierOptions {
  workspaceRoot: string;
  ignore?: string[];
  managedProcesses?: ManagedProcessInspector;
  defaultProbeTimeoutMs?: number;
  defaultCommandTimeoutMs?: number;
}

/**
 * Verifies observable acceptance predicates. Model prose and Agent command
 * results are deliberately not evidence: command criteria run independently
 * here, while service criteria probe live runtime state.
 */
export class AcceptanceVerifier {
  private readonly defaultProbeTimeoutMs: number;
  private readonly defaultCommandTimeoutMs: number;

  constructor(private readonly options: AcceptanceVerifierOptions) {
    this.defaultProbeTimeoutMs = options.defaultProbeTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.defaultProbeTimeoutMs) || this.defaultProbeTimeoutMs < 1) {
      throw new RangeError("defaultProbeTimeoutMs must be a positive safe integer.");
    }
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.defaultCommandTimeoutMs) || this.defaultCommandTimeoutMs < 1) {
      throw new RangeError("defaultCommandTimeoutMs must be a positive safe integer.");
    }
  }

  async verify(task: TaskContract, attempt: AgentAttemptExecution): Promise<AcceptanceVerificationResult> {
    const evidence: AcceptanceEvidence[] = [];
    if (attempt.outcomeStatus !== "completed" || attempt.stopReason !== "model_stop") {
      evidence.push(this.evidence(
        "agent_outcome",
        false,
        attempt.error ?? `Agent attempt is ${attempt.outcomeStatus} (${attempt.stopReason}); a terminal model stop is required.`,
        {
          finishReason: attempt.finishReason,
          runtimeSteps: attempt.runtimeSteps
        }
      ));
      return {
        passed: false,
        summary: evidence[0]?.summary ?? "Agent attempt did not complete.",
        evidence
      };
    }

    for (const criterion of task.acceptanceCriteria) evidence.push(await this.verifyCriterion(criterion));
    if (task.verificationMode === "deterministic" && task.acceptanceCriteria.length === 0) {
      evidence.push(this.evidence(
        "deterministic_verification",
        false,
        "This task requires deterministic verification, but no executable acceptance criteria were generated."
      ));
    }
    const failures = evidence.filter((item) => !item.passed);
    if (!failures.length) {
      return {
        passed: true,
        summary: task.acceptanceCriteria.length
          ? `All ${String(task.acceptanceCriteria.length)} acceptance criteria passed.`
          : "The agent reached a terminal model stop.",
        evidence
      };
    }
    return {
      passed: false,
      summary: `${String(failures.length)} acceptance ${failures.length === 1 ? "criterion" : "criteria"} failed: ${failures.map((item) => item.summary).join("; ")}`,
      evidence
    };
  }

  private async verifyCriterion(criterion: AcceptanceCriterion): Promise<AcceptanceEvidence> {
    try {
      if (criterion.kind === "file_exists") return await this.verifyFile(criterion);
      if (criterion.kind === "workspace_changed") return await this.verifyWorkspaceChanged(criterion);
      if (criterion.kind === "command_succeeded") return await this.verifyCommand(criterion);
      if (criterion.kind === "http") return await this.verifyHttp(criterion);
      if (criterion.kind === "tcp") return await this.verifyTcp(criterion);
      return await this.verifyManagedProcess(criterion);
    } catch (error) {
      return this.evidence(
        criterion.id,
        false,
        `${criterion.description ?? criterion.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async verifyFile(criterion: Extract<AcceptanceCriterion, { kind: "file_exists" }>): Promise<AcceptanceEvidence> {
    const absolutePath = resolveWorkspacePath(
      this.options.workspaceRoot,
      criterion.path,
      this.options.ignore ?? []
    );
    const stat = await fs.stat(absolutePath);
    const passed = stat.isFile() || stat.isDirectory();
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.path} exists.`
        : `${criterion.description ?? criterion.path} is not a regular file or directory.`,
      { path: path.relative(this.options.workspaceRoot, absolutePath), type: stat.isDirectory() ? "directory" : "file" }
    );
  }

  private async verifyWorkspaceChanged(
    criterion: Extract<AcceptanceCriterion, { kind: "workspace_changed" }>
  ): Promise<AcceptanceEvidence> {
    const digest = await workspaceStateDigest(this.options.workspaceRoot, this.options.ignore ?? []);
    const passed = digest !== criterion.baselineDigest;
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.id} changed from its task baseline.`
        : `${criterion.description ?? criterion.id} did not change from its task baseline.`,
      { baselineDigest: criterion.baselineDigest, digest }
    );
  }

  private async verifyCommand(
    criterion: Extract<AcceptanceCriterion, { kind: "command_succeeded" }>
  ): Promise<AcceptanceEvidence> {
    const cwd = resolveWorkspaceDirectory(
      this.options.workspaceRoot,
      criterion.cwd ?? ".",
      this.options.ignore ?? []
    );
    const result = await runShellCommand(cwd, criterion.command, {
      timeoutMs: criterion.timeoutMs ?? this.defaultCommandTimeoutMs
    });
    const passed = result.status === "completed" && result.exitCode === 0;
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.command} succeeded in an independent verifier run.`
        : `${criterion.description ?? criterion.command} failed in an independent verifier run (exit ${String(result.exitCode)}, ${result.status}).`,
      {
        execution: "independent_verifier",
        command: criterion.command,
        cwd: path.relative(this.options.workspaceRoot, cwd) || ".",
        status: result.status,
        exitCode: result.exitCode,
        stdout: compactOutput(result.stdout),
        stderr: compactOutput(result.stderr)
      }
    );
  }

  private async verifyHttp(criterion: Extract<AcceptanceCriterion, { kind: "http" }>): Promise<AcceptanceEvidence> {
    const timeoutMs = criterion.timeoutMs ?? this.defaultProbeTimeoutMs;
    const response = await fetch(criterion.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel();
    const expectedStatus = criterion.expectedStatus ?? 200;
    const passed = response.status === expectedStatus;
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? criterion.url} returned HTTP ${String(response.status)}.`
        : `${criterion.description ?? criterion.url} returned HTTP ${String(response.status)}; expected ${String(expectedStatus)}.`,
      { url: criterion.url, status: response.status, expectedStatus }
    );
  }

  private async verifyTcp(criterion: Extract<AcceptanceCriterion, { kind: "tcp" }>): Promise<AcceptanceEvidence> {
    const timeoutMs = criterion.timeoutMs ?? this.defaultProbeTimeoutMs;
    await connectTcp(criterion.host, criterion.port, timeoutMs);
    return this.evidence(
      criterion.id,
      true,
      `${criterion.description ?? `${criterion.host}:${String(criterion.port)}`} accepted a TCP connection.`,
      { host: criterion.host, port: criterion.port }
    );
  }

  private async verifyManagedProcess(
    criterion: Extract<AcceptanceCriterion, { kind: "managed_process" }>
  ): Promise<AcceptanceEvidence> {
    if (!this.options.managedProcesses) {
      return this.evidence(criterion.id, false, `${criterion.description ?? criterion.id}: managed process runtime is unavailable.`);
    }
    const processes = await this.options.managedProcesses.listProcesses();
    const matchingProcesses = processes.filter((candidate) => {
      if (criterion.processId !== undefined && candidate.processId !== criterion.processId) return false;
      if (criterion.url !== undefined && candidate.url !== criterion.url) return false;
      if (criterion.cwd !== undefined && path.resolve(this.options.workspaceRoot, criterion.cwd) !== path.resolve(candidate.cwd ?? "")) return false;
      return true;
    });
    const process = matchingProcesses.find((candidate) =>
      (candidate.state === "running" || candidate.state === "ready")
      && (readBoolean(candidate.readiness, "passed")
        ?? readBoolean(candidate.readiness, "ready")
        ?? (typeof candidate.readiness === "boolean" ? candidate.readiness : false))
      && (!criterion.requireHttpReadiness || readString(candidate.readiness, "type") === "http" && Boolean(candidate.url))
    ) ?? matchingProcesses.at(-1);
    if (!process) {
      return this.evidence(criterion.id, false, `${criterion.description ?? criterion.processId ?? criterion.url ?? criterion.id}: managed process was not found.`);
    }
    const readiness = readBoolean(process.readiness, "passed")
      ?? readBoolean(process.readiness, "ready")
      ?? (typeof process.readiness === "boolean" ? process.readiness : undefined);
    const readinessType = readString(process.readiness, "type");
    let passed = (process.state === "running" || process.state === "ready") && readiness === true;
    let liveHttpStatus: number | undefined;
    const liveUrl = criterion.url ?? process.url;
    if (criterion.requireHttpReadiness && (readinessType !== "http" || !liveUrl)) passed = false;
    if (passed && liveUrl) {
      try {
        const response = await fetch(liveUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.defaultProbeTimeoutMs)
        });
        liveHttpStatus = response.status;
        await response.body?.cancel();
        passed = response.status === 200;
      } catch {
        passed = false;
      }
    }
    return this.evidence(
      criterion.id,
      passed,
      passed
        ? `${criterion.description ?? process.processId} is managed, ready, and running${liveHttpStatus === 200 ? " (HTTP 200)" : ""}.`
        : `${criterion.description ?? process.processId} is ${process.state}${readiness === false ? " and its readiness probe failed" : readiness === undefined ? " without a successful readiness probe" : criterion.requireHttpReadiness && readinessType !== "http" ? " without required HTTP readiness" : criterion.requireHttpReadiness && !liveUrl ? " without a readiness URL" : liveUrl ? ` but live HTTP readiness returned ${String(liveHttpStatus ?? "no response")}` : ""}.`,
      { processId: process.processId, state: process.state, command: process.command, cwd: process.cwd, url: process.url, readiness, readinessType, liveHttpStatus }
    );
  }

  private evidence(
    criterionId: string,
    passed: boolean,
    summary: string,
    details?: Record<string, unknown>
  ): AcceptanceEvidence {
    const publicDetails = details === undefined ? undefined : redactSensitiveValue(details);
    return {
      criterionId,
      passed,
      summary,
      observedAt: new Date().toISOString(),
      details: isRecord(publicDetails) ? publicDetails : undefined
    };
  }
}

async function connectTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("TCP port must be between 1 and 65535.");
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP readiness timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function compactOutput(value: string): string | undefined {
  if (!value) return undefined;
  const maxChars = 4_000;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
