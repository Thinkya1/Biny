import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface MessageItemProps {
  message: TuiMessage;
  continuation?: boolean;
}

export function MessageItem({ message, continuation = false }: MessageItemProps): React.ReactElement {
  const color = message.role === "user" ? "green" : message.role === "assistant" ? "cyan" : message.role === "error" ? "red" : "gray";
  const label = message.role === "user" ? "›" : message.role === "assistant" ? "Biny" : message.role === "error" ? "Error" : "•";
  const lines = message.content.split("\n");
  if (!message.content) {
    return <Text> </Text>;
  }
  return (
    <Box flexDirection="column" marginBottom={message.role === "system" ? 0 : 1}>
      {lines.map((line, index) => (
        <Text key={`${message.id}-${String(index)}`}>
          {index === 0 && !continuation ? <Text color={color} bold>{label.padEnd(5)}</Text> : <Text color="gray">{"     "}</Text>}
          <MarkdownText line={line} muted={message.role === "system"} />
        </Text>
      ))}
    </Box>
  );
}
