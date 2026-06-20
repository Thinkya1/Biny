import type { RuntimeEvent, RuntimeEventSink } from "../../runtime/events.js";

export class TuiEventBridge {
  private readonly listeners = new Set<RuntimeEventSink>();

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: RuntimeEventSink): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
