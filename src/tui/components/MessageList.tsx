/**
 * 消息列表组件。
 *
 * TUI 会把 live messages 交给这里渲染。组件会把多行消息拆成连续行，并在新的用户消息前插入分隔线，
 * 让终端里的多轮对话更容易扫描。
 */
import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { TuiMessage } from "../types.js";
import { tuiColors } from "../theme/index.js";
import { MessageItem } from "./MessageItem.js";

export type MessageDisplayRow =
  | { type: "message"; id: string; message: TuiMessage; prefix: string }
  | { type: "separator"; id: string }
  | { type: "spacer"; id: string };

export interface MessageListProps {
  messages: TuiMessage[];
  visibleCount: number;
  scrollOffset: number;
  followLatest: boolean;
}

export function MessageList({ messages }: MessageListProps): React.ReactElement {
  // MessageList 动态渲染完整 transcript；终端 resize 时所有消息重新按当前宽度换行。
  const { columns } = useWindowSize();
  const rows = messageRowsForDisplay(messages);
  return (
    <Box flexDirection="column" width="100%">
      {rows.map((row) => (
        row.type === "separator"
          ? <Text key={row.id} color={tuiColors.border}>{separatorLine(columns)}</Text>
          : row.type === "spacer"
            ? <Text key={row.id}> </Text>
            : <MessageItem key={row.id} message={row.message} prefix={row.prefix} />
      ))}
    </Box>
  );
}

export function messageRowsForDisplay(messages: TuiMessage[]): MessageDisplayRow[] {
  // 在新的用户消息前插入分隔线，让多轮对话在终端里更容易扫描。
  const rows: MessageDisplayRow[] = [];
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

function flattenOneMessage(message: TuiMessage): MessageDisplayRow[] {
  // 多行消息拆成多行渲染；assistant 不保留名称占位，用户消息只在首行显示简短提示符。
  const rows: MessageDisplayRow[] = [];
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
      prefix: messagePrefix(message.role, index)
    });
  });
  if (message.role !== "system") {
    rows.push({
      type: "spacer",
      id: `${message.id}-spacer`
    });
  }
  return rows;
}

function messagePrefix(role: TuiMessage["role"], lineIndex: number): string {
  if (role === "assistant") return "";
  if (role === "user") return lineIndex === 0 ? "› " : "  ";
  if (role === "error") return lineIndex === 0 ? "Error " : "      ";
  return lineIndex === 0 ? "• " : "  ";
}

export function separatorLine(columns: number): string {
  return "─".repeat(Math.max(1, columns));
}
