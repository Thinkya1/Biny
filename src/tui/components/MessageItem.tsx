/**
 * 单条消息组件。
 *
 * 根据消息角色选择标签和颜色，并把正文交给轻量 Markdown 渲染器。多行消息会在后续行保留缩进，
 * system 消息则以更低调的样式展示。
 */
import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../types.js";
import { tuiColors } from "../theme/index.js";
import { MarkdownText } from "./MarkdownText.js";

export interface MessageItemProps {
  message: TuiMessage;
  continuation?: boolean;
}

export function MessageItem({ message, continuation = false }: MessageItemProps): React.ReactElement {
  // 角色决定标签和颜色；system/error 也走同一个展示路径。
  const color = message.role === "user" ? tuiColors.roleUser : message.role === "assistant" ? tuiColors.primary : message.role === "error" ? tuiColors.error : tuiColors.textDim;
  const label = message.role === "user" ? "›" : message.role === "assistant" ? "Biny" : message.role === "error" ? "Error" : "•";
  const isPlainSystemMessage = message.role === "system" && message.content.startsWith("Permission mode switched to ");
  const bodyColor = message.role === "error" ? tuiColors.error : isPlainSystemMessage ? tuiColors.text : undefined;
  const lines = message.content.split("\n");
  if (!message.content) {
    // 空行保留一行高度，用于消息之间的视觉间隔。
    return <Text> </Text>;
  }
  return (
    <Box flexDirection="column" marginBottom={message.role === "system" ? 0 : 1}>
      {lines.map((line, index) => (
        <Text key={`${message.id}-${String(index)}`}>
          {index === 0 && !continuation ? <Text color={color} bold>{label.padEnd(5)}</Text> : <Text color={tuiColors.textDim}>{"     "}</Text>}
          <MarkdownText line={line} muted={message.role === "system" && !isPlainSystemMessage} color={bodyColor} />
        </Text>
      ))}
    </Box>
  );
}
