/**
 * Agent 事件总线模块。
 *
 * AgentEventBus 是 runtime 到 UI 的同步事件广播层。它不保存历史，只负责把统一 RuntimeEvent
 * 分发给订阅者，避免 UI 直接依赖模型 SDK 或 agent loop 内部事件。
 */
import type { RuntimeEvent, RuntimeEventSink } from "./events.js";

export class AgentEventBus<TEvent = RuntimeEvent> {
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

  subscribe(listener: TEvent extends RuntimeEvent ? RuntimeEventSink : (event: TEvent) => void): () => void {
    const eventListener = listener as (event: TEvent) => void;
    this.listeners.add(eventListener);
    return () => {
      this.listeners.delete(eventListener);
    };
  }
}
