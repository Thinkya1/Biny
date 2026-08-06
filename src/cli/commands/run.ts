/**
 * 一次性 run 命令模块。
 *
 * `biny run <task>` 会创建标准命令运行时，执行单轮 agent 任务，然后打印 assistant 输出和
 * session 文件位置。它适合脚本化调用或不需要持续对话的任务。
 */
import type { AgentTurnOutcome } from "../../agent/types.js";
import { createFileConfigStore, type AgentConfigStore } from "../../config/store.js";
import type { AgentConfig } from "../../config/schema.js";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import { createCommandRuntime, type CommandRuntime } from "../../runtime/CommandRuntime.js";
import { ExecutionService } from "../../runtime/ExecutionService.js";
import { SessionLeaseStore, type SessionLease } from "../../runtime/SessionLease.js";
import { connectRuntimeHost, RuntimeHostClient } from "../../runtime/RuntimeHost.js";
import { runtimeIsBusy } from "../../runtime/agentEvents.js";
import type { UsageSummary } from "../../session/metadata.js";
import { withCliAbortSignal } from "../sigint.js";

export interface RunCommandOptions {
  /** 已在 Biny 配置中的模型 alias；不接受裸 provider model ID。 */
  model?: string;
  /** 覆盖本次运行的 hard step limit。 */
  maxSteps?: number;
  /** 覆盖本次运行的 soft step limit。 */
  softSteps?: number;
  /** 覆盖本次运行的权限模式。 */
  permissionMode?: Exclude<PermissionMode, "safe">;
  /** 无交互运行；会关闭 critical confirmation，并自动批准权限请求。 */
  headless?: boolean;
  /** 只输出一行 JSON，并允许非 completed 的 agent 终态交给外部 verifier 判定。 */
  json?: boolean;
}

export interface RunCommandResult {
  status: AgentTurnOutcome["status"];
  stopReason: AgentTurnOutcome["stopReason"];
  steps: number;
  error?: string;
  sessionId: string;
  sessionFile: string;
  modelAlias: string;
  provider: string;
  model: string;
  usage: UsageSummary;
}

export async function runCommand(workspaceRoot: string, input: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  validateRunOptions(options);
  const attached = canAttachRun(options)
    ? await connectRuntimeHost(workspaceRoot, { surface: "cli", clientId: `run-${process.pid}` })
    : undefined;
  if (attached) return await runAttachedCommand(attached, input, options);
  let runtime: CommandRuntime | undefined;
  let leases: SessionLeaseStore | undefined;
  let lease: SessionLease | undefined;
  let machineResult: RunCommandResult | undefined;
  try {
    runtime = await createCommandRuntime(workspaceRoot, {
      configStore: createRunConfigStore(workspaceRoot, options)
    });
    leases = await SessionLeaseStore.open(runtime.persistenceRoot);
    lease = leases.acquire(runtime.agent.getInfo().sessionId);
    const execution = await ExecutionService.create(runtime);
    const result = await withCliAbortSignal(async (signal) => await execution.execute({
      input,
      signal,
      confirmPermission: options.headless
        ? async () => ({ approved: true, scope: "session" as const })
        : undefined
    }));
    const info = result.session;
    machineResult = {
      status: result.turn.status,
      stopReason: result.turn.stopReason,
      steps: result.turn.steps,
      error: result.turn.error,
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      modelAlias: info.modelAlias,
      provider: info.provider,
      model: info.modelLabel,
      usage: runtime.agent.usageSummary()
    };
    if (!options.json) {
      if (result.turn.output) console.log(result.turn.output);
      console.log(`\nSession: ${result.session.sessionFile}`);
      assertCompletedCliRun(result.turn);
    }
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
  if (!machineResult) throw new Error("Biny run ended without a structured result.");
  if (options.json) console.log(JSON.stringify(machineResult));
  return machineResult;
}

async function runAttachedCommand(
  runtime: RuntimeHostClient,
  input: string,
  options: RunCommandOptions
): Promise<RunCommandResult> {
  try {
    if (runtimeIsBusy(runtime.getSnapshot())) throw new Error("Runtime Host is already running another task.");
    const submitted = runtime.submitPrompt(input, "chat");
    const turn = await withCliAbortSignal(async (signal) => {
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
    const info = runtime.getSnapshot().info;
    const usage = (await runtime.usage()).summary as UsageSummary;
    const result: RunCommandResult = {
      status: turn.status,
      stopReason: turn.stopReason,
      steps: turn.steps,
      error: turn.error,
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      modelAlias: info.modelAlias,
      provider: info.provider,
      model: info.modelLabel,
      usage
    };
    if (!options.json) {
      if (turn.output) console.log(turn.output);
      console.log(`\nSession: ${info.sessionFile}`);
      assertCompletedCliRun(turn);
    }
    if (options.json) console.log(JSON.stringify(result));
    return result;
  } finally {
    await runtime.close();
  }
}

function canAttachRun(options: RunCommandOptions): boolean {
  return options.model === undefined
    && options.maxSteps === undefined
    && options.softSteps === undefined
    && options.permissionMode === undefined
    && options.headless !== true;
}

function createRunConfigStore(workspaceRoot: string, options: RunCommandOptions): AgentConfigStore {
  const base = createFileConfigStore(workspaceRoot);
  const revision = base.revision;
  return {
    load: async (requestedWorkspaceRoot) => {
      const config = await base.load(requestedWorkspaceRoot);
      return applyRunConfig(config, options);
    },
    save: async (config, requestedWorkspaceRoot) => await base.save(config, requestedWorkspaceRoot),
    revision: revision ? () => revision() : undefined
  };
}

export function applyRunConfig(config: AgentConfig, options: RunCommandOptions): AgentConfig {
  if (options.model !== undefined) {
    if (!config.models[options.model]) throw new Error(`Unknown model alias: ${options.model}`);
    config.defaultModel = options.model;
  }
  if (options.maxSteps !== undefined) config.agent.hardStepLimit = options.maxSteps;
  if (options.softSteps !== undefined) config.agent.softStepLimit = options.softSteps;
  if (options.permissionMode !== undefined) config.permission.mode = options.permissionMode;
  if (options.headless) {
    config.permission.mode = options.permissionMode ?? "full-access";
    config.permission.criticalAlwaysAsk = false;
  }
  return config;
}

export function validateRunOptions(options: RunCommandOptions): void {
  validateStepLimit("maxSteps", options.maxSteps);
  validateStepLimit("softSteps", options.softSteps);
  if (options.softSteps !== undefined && options.maxSteps !== undefined && options.softSteps > options.maxSteps) {
    throw new Error("softSteps cannot be greater than maxSteps.");
  }
  if (options.permissionMode !== undefined && !["ask", "read-only", "auto", "full-access"].includes(options.permissionMode)) {
    throw new Error("permissionMode must be one of ask, read-only, auto, full-access.");
  }
}

function validateStepLimit(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 1_024) {
    throw new Error(`${name} must be an integer between 1 and 1024.`);
  }
}

/** Throwing here lets the CLI composition root set a non-zero exit status. */
export function assertCompletedCliRun(outcome: AgentTurnOutcome): void {
  if (outcome.status === "completed") return;
  const detail = outcome.error ?? `Agent task stopped with ${outcome.stopReason} after ${String(outcome.steps)} steps.`;
  throw new Error(`Agent task ${outcome.status}: ${detail}`);
}
