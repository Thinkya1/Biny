/**
 * Session replay projection.
 *
 * Recorded events are rebuilt into the same discriminated TranscriptItem
 * model used by live rendering. Tool calls and results are paired by id (with
 * a same-tool fallback for older sessions) instead of becoming system text.
 */
import type { SessionEvent } from "../session/recorder.js";
import { completeToolItem, createRunningToolItem } from "./toolPresentation.js";
import type { ToolTranscriptItem, TranscriptItem } from "./types.js";

export function sessionEventsToTranscript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const pendingTools: ToolTranscriptItem[] = [];

  for (const [index, event] of events.entries()) {
    if (event.type === "user_message") {
      items.push({ id: replayId("user", index), kind: "user", content: event.content });
      continue;
    }

    if (event.type === "assistant_message") {
      if (event.content) items.push({ id: replayId("assistant", index), kind: "assistant", content: event.content });
      continue;
    }

    if (event.type === "tool_call") {
      pendingTools.push(createRunningToolItem({
        id: replayId(`tool-${event.tool}`, index),
        toolCallId: event.toolCallId,
        tool: event.tool,
        args: event.args,
        startedAtMs: eventTimeMs(event.time)
      }));
      continue;
    }

    if (event.type === "tool_result") {
      const pendingIndex = findPendingTool(pendingTools, event.toolCallId, event.tool);
      const running = pendingIndex === -1
        ? createRunningToolItem({
          id: replayId(`tool-${event.tool}`, index),
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: {},
          startedAtMs: undefined
        })
        : pendingTools[pendingIndex];
      if (!running) continue;
      if (pendingIndex !== -1) pendingTools.splice(pendingIndex, 1);
      items.push(completeToolItem(running, event.result, undefined, eventTimeMs(event.time) ?? Number.NaN));
      continue;
    }

    while (pendingTools.length > 0) {
      const pending = pendingTools.shift();
      if (pending) items.push(completeToolItem(pending, { error: event.message }, "failed", eventTimeMs(event.time) ?? Number.NaN));
    }
    items.push({ id: replayId("error", index), kind: "error", content: event.message });
  }

  for (const pending of pendingTools) {
    items.push(completeToolItem({ ...pending, startedAtMs: undefined }, { error: "Interrupted before completion." }, "skipped"));
  }
  return items;
}

function findPendingTool(pending: ToolTranscriptItem[], toolCallId: string | undefined, tool: string): number {
  if (toolCallId) {
    return pending.findIndex((item) => item.toolCallId === toolCallId);
  }
  return pending.findIndex((item) => item.tool === tool);
}

function replayId(kind: string, index: number): string {
  return `loaded-${kind}-${String(index + 1)}`;
}

function eventTimeMs(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const value = Date.parse(time);
  return Number.isFinite(value) ? value : undefined;
}
