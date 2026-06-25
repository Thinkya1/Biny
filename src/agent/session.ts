/**
 * Agent loop 会话消息模块。
 *
 * ReAct 循环需要把用户输入、assistant 输出、工具调用结果持续写回同一个消息数组。
 * 这里提供小型 helper，让 loop 本身专注于事件流和工具执行。
 */
import type { ChatMessage, LLMToolCall } from "../llm/provider.js";

export function createInitialMessages(systemPrompt: string, userInput: string, history: ChatMessage[] = []): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userInput }
  ];
}

export function appendAssistantMessage(messages: ChatMessage[], content: string): ChatMessage[] {
  return [...messages, { role: "assistant", content }];
}

export function appendAssistantToolCallMessage(messages: ChatMessage[], content: string, toolCalls: LLMToolCall[]): ChatMessage[] {
  return [...messages, { role: "assistant", content, toolCalls }];
}

export function appendToolResultMessage(messages: ChatMessage[], toolCallId: string, toolName: string, result: unknown): ChatMessage[] {
  return [
    ...messages,
    {
      role: "tool",
      toolCallId,
      name: toolName,
      content: stringifyToolResult(result)
    }
  ];
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
