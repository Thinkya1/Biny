/**
 * TUI transcript 投影辅助。
 *
 * 早期 TUI 用 Ink Static 分区渲染历史消息和 live 消息；Static 输出不会响应终端 resize，
 * 因此聊天主界面现在应使用 resizableTranscriptMessages 返回的同一份动态消息流。
 */
import type { RuntimeStatus } from "../runtime/events.js";
import type { TuiMessage } from "./types.js";

export interface TranscriptSplit {
  staticMessages: TuiMessage[];
  liveMessages: TuiMessage[];
}

export function splitTranscriptMessages(messages: TuiMessage[], status: RuntimeStatus | string): TranscriptSplit {
  const runningToolIndex = messages.findIndex((message) => isRunningToolMessage(message));
  if (runningToolIndex !== -1) {
    return {
      staticMessages: messages.slice(0, runningToolIndex),
      liveMessages: messages.slice(runningToolIndex)
    };
  }

  const last = messages[messages.length - 1];
  const hasLiveAssistant = last?.role === "assistant" && (status === "thinking" || status === "running" || status === "waiting_permission");
  if (!hasLiveAssistant) return { staticMessages: messages, liveMessages: [] };
  return { staticMessages: messages.slice(0, -1), liveMessages: [last] };
}

export function resizableTranscriptMessages(messages: TuiMessage[]): TuiMessage[] {
  // 返回原始数组，让 MessageList 随窗口宽度重新渲染所有消息，避免 Static 固定旧换行。
  return messages;
}

function isRunningToolMessage(message: TuiMessage): boolean {
  return message.role === "system"
    && message.id.startsWith("tool-message-")
    && message.content.startsWith("… ");
}
