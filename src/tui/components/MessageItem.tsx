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
  prefix?: string;
}

export function MessageItem({ message, prefix }: MessageItemProps): React.ReactElement {
  // 角色决定提示符和正文颜色；assistant 不显示名称，减少横向占位。
  const resolvedPrefix = prefix ?? defaultPrefix(message.role);
  const prefixColor = message.role === "user" ? tuiColors.roleUser : message.role === "error" ? tuiColors.error : tuiColors.textDim;
  const isPlainSystemMessage = message.role === "system" && message.content.startsWith("Permission mode switched to ");
  const bodyColor = message.role === "user" ? tuiColors.textStrong : message.role === "error" ? tuiColors.error : isPlainSystemMessage ? tuiColors.text : undefined;
  const lines = message.content.split("\n");
  if (!message.content) {
    // 空行保留一行高度，用于消息之间的视觉间隔。
    return <Text> </Text>;
  }
  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line, index) => (
        <Text key={`${message.id}-${String(index)}`}>
          <Text color={prefixColor} bold={message.role === "user"}>{index === 0 ? resolvedPrefix : continuationPrefix(resolvedPrefix)}</Text>
          <MarkdownText line={line} muted={message.role === "system" && !isPlainSystemMessage} color={bodyColor} />
        </Text>
      ))}
    </Box>
  );
}

function defaultPrefix(role: TuiMessage["role"]): string {
  if (role === "assistant") return "";
  if (role === "user") return "› ";
  if (role === "error") return "Error ";
  return "• ";
}

function continuationPrefix(prefix: string): string {
  return " ".repeat(prefix.length);
}
