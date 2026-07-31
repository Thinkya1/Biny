/**
 * 显式 durable task 执行入口。
 *
 * 普通 Chat、Desktop、TUI 与 `biny run` 都不会引用本服务。只有明确需要跨 Attempt
 * 持久化、恢复和独立任务契约的调用方才应主动创建它。
 */
import { randomUUID } from "node:crypto";
import type { AgentSessionInfo } from "../agent/AgentSession.js";
import { TaskRunStore } from "../harness/TaskRunStore.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import {
  type TaskRunCoordinatorResult,
  TaskRunCoordinator
} from "./TaskRunCoordinator.js";
import type { ExecutionOptions } from "./ExecutionService.js";

export interface DurableTaskExecutionResult extends TaskRunCoordinatorResult {
  runId: string;
  session: AgentSessionInfo;
}

export class DurableTaskExecutionService {
  private readonly coordinator: TaskRunCoordinator;

  constructor(
    private readonly runtime: CommandRuntime,
    taskRuns: TaskRunStore
  ) {
    this.coordinator = new TaskRunCoordinator({ runtime, taskRunStore: taskRuns });
  }

  static async create(runtime: CommandRuntime): Promise<DurableTaskExecutionService> {
    return new DurableTaskExecutionService(runtime, await TaskRunStore.open(runtime.persistenceRoot));
  }

  async execute(options: ExecutionOptions): Promise<DurableTaskExecutionResult> {
    const runId = randomUUID();
    const session = this.runtime.agent.getInfo();
    const result = await this.coordinator.execute({
      runId,
      sessionId: session.sessionId,
      input: options.input,
      attachments: options.attachments,
      signal: options.signal,
      confirmPermission: options.confirmPermission
    });
    if (result.turn.status === "completed") {
      this.runtime.agent.rememberSuccessfulTask(options.input, result.turn.output);
    }
    return { ...result, runId, session };
  }
}
