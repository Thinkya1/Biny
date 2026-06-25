/**
 * Agent 事件总线模块。
 *
 * AgentEventBus 是 runtime 到 UI 的同步事件广播层。它不保存历史，只负责把统一 RuntimeEvent
 * 分发给订阅者，避免 UI 直接依赖模型 SDK 或 agent loop 内部事件。
 */
import type { RuntimeEvent, RuntimeEventSink } from "./events.js";

export class AgentEventBus {
  private readonly listeners = new Set<RuntimeEventSink>();

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: RuntimeEventSink): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
