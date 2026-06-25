/**
 * 工具调度器。
 *
 * 同一批模型 tool_calls 中，资源不冲突的工具可以并发；涉及同一路径写入或未知副作用的工具会等待。
 * 调度器只负责启动时机，不负责 UI、权限或 transcript 顺序。
 */
import { ToolAccesses, type ToolAccessList } from "./access.js";

export interface ToolSchedulerTask<TResult> {
  accesses: ToolAccessList;
  start(): Promise<TResult>;
}

interface QueuedTask<TResult> {
  task: ToolSchedulerTask<TResult>;
  resolve(result: TResult): void;
  reject(error: unknown): void;
  started: boolean;
}

interface ActiveTask<TResult> {
  task: ToolSchedulerTask<TResult>;
}

export class ToolScheduler<TResult> {
  private readonly queue: Array<QueuedTask<TResult>> = [];
  private readonly active: Array<ActiveTask<TResult>> = [];

  schedule(task: ToolSchedulerTask<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      this.queue.push({ task, resolve, reject, started: false });
      this.pump();
    });
  }

  private pump(): void {
    for (const item of this.queue) {
      if (item.started || this.isBlocked(item.task)) continue;
      item.started = true;
      const activeItem: ActiveTask<TResult> = { task: item.task };
      this.active.push(activeItem);
      void item.task.start()
        .then((result) => item.resolve(result))
        .catch((error: unknown) => item.reject(error))
        .finally(() => {
          const index = this.active.indexOf(activeItem);
          if (index !== -1) this.active.splice(index, 1);
          const queueIndex = this.queue.indexOf(item);
          if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
          this.pump();
        });
    }
  }

  private isBlocked(task: ToolSchedulerTask<TResult>): boolean {
    return this.active.some((active) => ToolAccesses.conflict(task.accesses, active.task.accesses));
  }
}
