/**
 * 自主执行能力入口。
 *
 * 普通 Chat/Plan 不创建任务契约、验收器或 durable task store；只有明确的 autonomous
 * 运行第一次使用该服务时，才装配这组执行能力。
 */
import { TaskRunStore } from "../harness/TaskRunStore.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
import { InteractiveAgentRuntime } from "./InteractiveAgentRuntime.js";
import { SessionLeaseStore } from "./SessionLease.js";
import {
  TaskRunCoordinator,
  type TaskRunCoordinatorExecution,
  type TaskRunCoordinatorResult
} from "./TaskRunCoordinator.js";

export class ExecutionService {
  private readonly coordinator: TaskRunCoordinator;

  constructor(runtime: CommandRuntime, taskRuns: TaskRunStore) {
    this.coordinator = new TaskRunCoordinator({ runtime, taskRunStore: taskRuns });
  }

  static async create(runtime: CommandRuntime): Promise<ExecutionService> {
    return new ExecutionService(runtime, await TaskRunStore.open(runtime.persistenceRoot));
  }

  async execute(options: TaskRunCoordinatorExecution): Promise<TaskRunCoordinatorResult> {
    return await this.coordinator.execute(options);
  }
}

/** `biny run` 的独立 composition root；交互式 Runtime 不导入本模块。 */
export async function createAutonomousAgentRuntime(
  workspaceRoot: string,
  options?: CommandRuntimeOptions
): Promise<InteractiveAgentRuntime> {
  const sessionLeases = await SessionLeaseStore.open(options?.persistenceRoot ?? workspaceRoot);
  let commandRuntime: CommandRuntime | undefined;
  try {
    commandRuntime = await createCommandRuntime(workspaceRoot, options);
    const autonomousExecutor = await ExecutionService.create(commandRuntime);
    return new InteractiveAgentRuntime(commandRuntime, { sessionLeases, autonomousExecutor });
  } catch (error) {
    await commandRuntime?.close();
    sessionLeases.close();
    throw error;
  }
}
