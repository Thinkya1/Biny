import type { ModelMessage } from "ai";
import { readSessionEvents } from "./events.js";
import type { SessionEvent } from "./recorder.js";

export interface SessionReplay {
  events: SessionEvent[];
  messages: ModelMessage[];
}

export async function replaySession(filePath: string): Promise<SessionReplay> {
  const events = await readSessionEvents(filePath);
  return { events, messages: sessionEventsToConversation(events) };
}

export function sessionEventsToConversation(events: SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const pendingCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const openCalls = new Map<string, { id: string; name: string; args: unknown }>();
  let pendingAssistantContent = "";
  let pendingReasoningContent: string | undefined;
  let callsFlushed = false;

  const flushPendingCalls = (): void => {
    if (!pendingCalls.length || callsFlushed) return;
    messages.push({
      role: "assistant",
      content: [
        ...(pendingReasoningContent ? [{ type: "reasoning" as const, text: pendingReasoningContent }] : []),
        ...(pendingAssistantContent ? [{ type: "text" as const, text: pendingAssistantContent }] : []),
        ...pendingCalls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: call.args }))
      ]
    });
    callsFlushed = true;
  };

  const resetPendingCalls = (): void => {
    pendingCalls.splice(0, pendingCalls.length);
    openCalls.clear();
    pendingAssistantContent = "";
    pendingReasoningContent = undefined;
    callsFlushed = false;
  };

  for (const [index, event] of events.entries()) {
    if (event.type === "user_message") {
      flushPendingCalls();
      resetPendingCalls();
      messages.push({ role: "user", content: event.content });
      continue;
    }

    if (event.type === "assistant_message") {
      flushPendingCalls();
      resetPendingCalls();
      messages.push({
        role: "assistant",
        content: [
          ...(event.reasoningContent ? [{ type: "reasoning" as const, text: event.reasoningContent }] : []),
          ...(event.content ? [{ type: "text" as const, text: event.content }] : [])
        ]
      });
      continue;
    }

    if (event.type === "tool_call") {
      if (callsFlushed && openCalls.size === 0) resetPendingCalls();
      const toolCall = {
        id: event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`,
        name: event.tool,
        args: event.args
      };
      pendingAssistantContent = event.assistantContent ?? pendingAssistantContent;
      pendingReasoningContent = event.reasoningContent ?? pendingReasoningContent;
      pendingCalls.push(toolCall);
      openCalls.set(toolCall.id, toolCall);
      callsFlushed = false;
      continue;
    }

    if (event.type === "tool_result") {
      const toolCallId = event.toolCallId ?? findToolCallId(openCalls, event.tool) ?? `session-tool-${String(event.sequence ?? index + 1)}`;
      flushPendingCalls();
      messages.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId, toolName: event.tool, output: { type: "text", value: stringifyResult(event.result) } }]
      });
      openCalls.delete(toolCallId);
      continue;
    }

    flushPendingCalls();
  }

  flushPendingCalls();
  return messages;
}

function findToolCallId(calls: Map<string, { id: string; name: string; args: unknown }>, toolName: string): string | undefined {
  return [...calls.values()].find((call) => call.name === toolName)?.id;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
