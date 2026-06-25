/**
 * 权限确认组件。
 *
 * 当 agent 请求执行写入、编辑或命令工具时，TUI 会显示这个确认框。组件展示详情或 diff，
 * 并把用户选择回传给 TUI runtime。
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TUI_KEYS } from "../keymap.js";
import { movePermissionSelection, permissionChoiceAt, permissionOptions } from "../permissionOptions.js";
import { tuiColors } from "../theme/index.js";
import type { PermissionChoice, TuiPermissionRequest } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface PermissionPromptProps {
  request?: TuiPermissionRequest;
  detailsExpanded: boolean;
  onAnswer: (choice: PermissionChoice) => void;
  onToggleDetails: () => void;
}

export function PermissionPrompt({ request, detailsExpanded, onAnswer, onToggleDetails }: PermissionPromptProps): React.ReactElement | null {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [request]);

  useInput((input, key) => {
    // 权限框激活时只处理确认相关快捷键，其他输入仍由外层忽略。
    if (!request) return;
    if ((key.ctrl && input.toLowerCase() === "e") || (key.ctrl && input.toLowerCase() === "o")) onToggleDetails();
    if (key.upArrow) {
      setSelectedIndex((current) => movePermissionSelection(current, -1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => movePermissionSelection(current, 1));
      return;
    }
    if (key.return) {
      onAnswer(permissionChoiceAt(selectedIndex));
      return;
    }
    if (input.toLowerCase() === TUI_KEYS.approve) {
      onAnswer("approve_once");
      return;
    }
    if (input.toLowerCase() === TUI_KEYS.reject) {
      onAnswer("reject");
    }
  }, { isActive: request !== undefined });

  if (!request) return null;

  // 展开时优先显示 diff；折叠时显示较短 details，避免权限框占满屏幕。
  const detailSource = request.preview ?? (request.diff && detailsExpanded ? request.diff : request.details);
  const detailLines = detailSource.split("\n");
  const lines = detailsExpanded ? detailLines.slice(0, 80) : detailLines.slice(0, 16);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={tuiColors.borderFocus} paddingX={1} marginBottom={1}>
      <Text color={tuiColors.warning} bold>{request.title}</Text>
      <Text>Tool: {request.tool}</Text>
      <Text>Action: {request.actionType}  Risk: {request.riskLevel}</Text>
      {request.targetPath ? <Text>Target: {request.targetPath}</Text> : null}
      {request.command ? <Text>Command: {request.command}</Text> : null}
      {request.reason ? <Text>Reason: {request.reason}</Text> : null}
      {request.changeSummary ? <Text>Summary: {request.changeSummary}</Text> : null}
      {request.requireFullYes ? <Text color={tuiColors.error}>Critical or sensitive operation: review before accepting.</Text> : null}
      {lines.map((line, index) => (
        <MarkdownText key={`${request.tool}-${String(index)}`} line={line} />
      ))}
      <Box flexDirection="column" marginTop={1}>
        {permissionOptions.map((option, index) => {
          const selected = index === selectedIndex;
          const color = option.dangerous ? tuiColors.error : selected ? tuiColors.warning : undefined;
          return (
            <Text key={option.choice} color={color} bold={selected}>
              {selected ? "❯ " : "  "}
              {option.label}
              <Text color={tuiColors.textDim}>  {option.description}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={tuiColors.textDim}>↑↓ navigate · Enter select · y execute · n deny · Ctrl-E details</Text>
    </Box>
  );
}
