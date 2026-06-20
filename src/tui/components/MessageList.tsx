import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../types.js";
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
  const rows = flattenMessages(messages);
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        row.type === "separator"
          ? <Text key={row.id} color="gray">────────────────────────────────────────────────────────────────</Text>
          : <MessageItem key={row.id} message={row.message} continuation={row.continuation} />
      ))}
    </Box>
  );
}

function flattenMessages(messages: TuiMessage[]): MessageRow[] {
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
