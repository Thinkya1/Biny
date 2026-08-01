/**
 * AgentMessage 读取工具。
 *
 * 模型消息内容既可能是字符串也可能是分片数组，各处都要判一遍很啰嗦，这里统一提供
 * 取文本、取思考内容、取工具名和深拷贝的读法。
 */
import type { AgentMessage } from "./core/types.js";

/** 拼出消息的纯文本形态；工具调用/结果按 JSON 展开，图片等无文本分片忽略。 */
export function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text;
    if (part.type === "toolCall") return stringify(part.arguments);
    if (part.type === "image") return `[${part.mimeType} image]`;
    if (part.type === "audio") return `[${part.mimeType} audio]`;
    return "";
  }).join("");
}

export function messageReasoning(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
}

export function messageToolName(message: AgentMessage): string {
  return message.role === "toolResult" ? message.toolName : "tool";
}

/** 浅拷贝到分片一层：压缩、重试等流程会改写消息数组，不能影响调用方持有的原始消息。 */
export function cloneAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : message.content
  })) as AgentMessage[];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
