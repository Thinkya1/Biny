import type { ModelMessage } from "ai";

export function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text;
    if (part.type === "tool-call") return stringify(part.input);
    if (part.type === "tool-result") return stringify(part.output);
    return "";
  }).join("");
}

export function messageReasoning(message: ModelMessage): string {
  if (message.role !== "assistant" || typeof message.content === "string") return "";
  return message.content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
}

export function messageToolName(message: ModelMessage): string {
  if (message.role !== "tool") return "tool";
  const result = message.content[0];
  return result?.type === "tool-result" ? result.toolName : "tool";
}

export function cloneModelMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : message.content
  })) as ModelMessage[];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
