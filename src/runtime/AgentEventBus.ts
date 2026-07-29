/**
 * Agent 事件总线模块。
 *
 * AgentEventBus 是 runtime 到 UI 的同步事件广播层。它不保存历史，只负责把指定事件类型
 * 分发给订阅者，避免 UI 直接依赖模型 SDK 或 agent loop 内部事件。
 */
export class AgentEventBus<TEvent> {
  private readonly listeners = new Set<(event: TEvent) => void>();

  emit(event: TEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A renderer or host listener must not interrupt the agent lifecycle.
        this.listeners.delete(listener);
      }
    }
  }

  subscribe(listener: (event: TEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
