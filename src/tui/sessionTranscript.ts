import path from "node:path";
import type { SessionEvent } from "../session/recorder.js";

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "error";
  content: string;
}

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

export function sessionEventsToMessages(workspaceRoot: string, filePath: string, events: SessionEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [
    {
      role: "system",
      content: `Resumed session ${sessionIdFromFile(filePath)}\n${path.relative(workspaceRoot, filePath)}`
    }
  ];

  for (const event of events) {
    if (event.type === "user_message") {
      messages.push({ role: "user", content: event.content });
      continue;
    }

    if (event.type === "assistant_message") {
      messages.push({ role: "assistant", content: event.content });
      continue;
    }

    if (event.type === "tool_call") {
      messages.push({ role: "system", content: `tool call: ${event.tool}\n${summarize(event.args)}` });
      continue;
    }

    if (event.type === "tool_result") {
      messages.push({ role: "system", content: `tool result: ${event.tool}\n${summarize(event.result)}` });
      continue;
    }

    messages.push({ role: "error", content: event.message });
  }

  return messages;
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 800);
  try {
    return JSON.stringify(value, null, 2).slice(0, 800);
  } catch {
    return String(value).slice(0, 800);
  }
}
