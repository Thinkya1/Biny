/**
 * 消息列表组件。
 *
 * TUI 会把 live messages 交给这里渲染。组件会把多行消息拆成连续行，并在新的用户消息前插入分隔线，
 * 让终端里的多轮对话更容易扫描。
 */
import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../types.js";
import { tuiColors } from "../theme/index.js";
import { MessageItem } from "./MessageItem.js";

type MessageRow =
  | { type: "message"; id: string; message: TuiMessage; continuation: boolean }
  | { type: "separator"; id: string };

export interface MessageListProps {
  messages: TuiMessage[];
  visibleCount: number;
  scrollOffset: number;
  followLatest: boolean;
}

export function MessageList({ messages }: MessageListProps): React.ReactElement {
  // MessageList 只渲染传入的 live messages；静态历史由 App 的 <Static> 承载。
  const rows = flattenMessages(messages);
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        row.type === "separator"
          ? <Text key={row.id} color={tuiColors.border}>────────────────────────────────────────────────────────────────</Text>
          : <MessageItem key={row.id} message={row.message} continuation={row.continuation} />
      ))}
    </Box>
  );
}

function flattenMessages(messages: TuiMessage[]): MessageRow[] {
  // 在新的用户消息前插入分隔线，让多轮对话在终端里更容易扫描。
  const rows: MessageRow[] = [];
  let hasConversation = false;
  for (const message of messages) {
    if (message.role === "user" && hasConversation) {
      rows.push({
        type: "separator",
        id: `${message.id}-separator`
      });
    }
    rows.push(...flattenOneMessage(message));
    if (message.role === "user" || message.role === "assistant") {
      hasConversation = true;
    }
  }
  return rows;
}

function flattenOneMessage(message: TuiMessage): MessageRow[] {
  // 多行消息拆成多行渲染，首行显示角色标签，后续行做缩进延续。
  const rows: MessageRow[] = [];
  const lines = message.content.split("\n");
  lines.forEach((line, index) => {
    rows.push({
      type: "message",
      id: `${message.id}-${String(index)}`,
      message: {
        ...message,
        id: `${message.id}-${String(index)}`,
        content: line
      },
      continuation: index > 0
    });
  });
  if (message.role !== "system") {
    rows.push({
      type: "message",
      id: `${message.id}-spacer`,
      message: { id: `${message.id}-spacer`, role: "system", content: "" },
      continuation: true
    });
  }
  return rows;
}
