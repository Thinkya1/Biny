/**
 * 自主执行能力入口。
 *
 * 普通 Chat/Plan 不创建任务契约、验收器或 durable task store；只有 `biny run`
 * 显式进入本服务。
 */
import { randomUUID } from "node:crypto";
import type { AgentAttachment, AgentSessionInfo } from "../agent/AgentSession.js";
import type { AgentPermissionRequest, AgentPermissionResult } from "../agent/types.js";
import { TaskRunStore } from "../harness/TaskRunStore.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import {
  TaskRunCoordinator,
  type TaskRunCoordinatorResult
} from "./TaskRunCoordinator.js";

export interface ExecutionOptions {
  input: string;
  signal: AbortSignal;
  attachments?: AgentAttachment[];
  confirmPermission?(request: AgentPermissionRequest): Promise<AgentPermissionResult>;
}

export interface ExecutionResult extends TaskRunCoordinatorResult {
  runId: string;
  session: AgentSessionInfo;
}

export class ExecutionService {
  private readonly coordinator: TaskRunCoordinator;

  constructor(
    private readonly runtime: CommandRuntime,
    taskRuns: TaskRunStore
  ) {
    this.coordinator = new TaskRunCoordinator({ runtime, taskRunStore: taskRuns });
  }

  static async create(runtime: CommandRuntime): Promise<ExecutionService> {
    return new ExecutionService(runtime, await TaskRunStore.open(runtime.persistenceRoot));
  }

  async execute(options: ExecutionOptions): Promise<ExecutionResult> {
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
