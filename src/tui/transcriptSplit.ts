/**
 * TUI transcript 分区辅助。
 *
 * Ink Static 渲染过的内容不会再更新；运行中的工具消息必须留在 live 区域，等结果更新后再进入
 * Static，否则界面会一直停在 `… tool`。
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

function isRunningToolMessage(message: TuiMessage): boolean {
  return message.role === "system"
    && message.id.startsWith("tool-message-")
    && message.content.startsWith("… ");
}
