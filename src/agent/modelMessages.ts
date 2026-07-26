/**
 * ModelMessage 读取工具。
 *
 * AI SDK 的消息内容既可能是字符串也可能是分片数组，各处都要判一遍很啰嗦，这里统一提供
 * 取文本、取思考内容、取工具名和深拷贝的读法。
 */
import type { ModelMessage } from "ai";

/** 拼出消息的纯文本形态；工具调用/结果按 JSON 展开，图片等无文本分片忽略。 */
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

/** 浅拷贝到分片一层：压缩、重试等流程会改写消息数组，不能影响调用方持有的原始消息。 */
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
