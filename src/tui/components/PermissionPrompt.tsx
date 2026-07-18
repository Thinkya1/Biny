/**
 * 权限确认组件。
 *
 * 当 agent 请求执行写入、编辑或命令工具时，TUI 会显示这个确认框。组件展示详情或 diff，
 * 并把用户选择回传给 TUI runtime。
 */
import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";
import { TUI_KEYS } from "../keymap.js";
import {
  appendPermissionConfirmation,
  confirmedPermissionChoice,
  createPermissionPromptInteractionState,
  movePermissionSelection,
  permissionOptions,
  permissionPromptStateForRequest
} from "../permissionOptions.js";
import { tuiColors } from "../theme/index.js";
import type { PermissionChoice, TuiPermissionRequest } from "../types.js";
import { DialogFrame } from "./DialogFrame.js";
import { MarkdownText } from "./MarkdownText.js";

export interface PermissionPromptProps {
  request?: TuiPermissionRequest;
  detailsExpanded: boolean;
  onAnswer: (choice: PermissionChoice) => void;
  onToggleDetails: () => void;
}

export function PermissionPrompt({ request, detailsExpanded, onAnswer, onToggleDetails }: PermissionPromptProps): React.ReactElement | null {
  const [interaction, setInteraction] = useState(() => createPermissionPromptInteractionState(request));
  const activeInteraction = permissionPromptStateForRequest(interaction, request);

  useEffect(() => {
    setInteraction(createPermissionPromptInteractionState(request));
  }, [request]);

  useInput((input, key) => {
    // 权限框激活时只处理确认相关快捷键，其他输入仍由外层忽略。
    if (!request) return;
    if ((key.ctrl && input.toLowerCase() === "e") || (key.ctrl && input.toLowerCase() === "o")) {
      onToggleDetails();
      return;
    }
    if (key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (key.return) {
      const choice = confirmedPermissionChoice(
        activeInteraction.selectedIndex,
        request.requireFullYes,
        activeInteraction.confirmation
      );
      if (choice) onAnswer(choice);
      else updateInteraction({ confirmationAttempted: true });
      return;
    }
    if (!request.requireFullYes && input.toLowerCase() === TUI_KEYS.approve) {
      onAnswer("approve_once");
      return;
    }
    if (input.toLowerCase() === TUI_KEYS.reject) {
      onAnswer("reject");
      return;
    }
    if (!request.requireFullYes || key.ctrl || key.meta) return;
    if (key.backspace || key.delete) {
      updateInteraction({
        confirmation: activeInteraction.confirmation.slice(0, -1),
        confirmationAttempted: false
      });
      return;
    }
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (!nextInput) return;
    updateInteraction({
      confirmation: appendPermissionConfirmation(activeInteraction.confirmation, nextInput),
      confirmationAttempted: false
    });
  }, { isActive: request !== undefined });

  if (!request) return null;

  // 展开时优先显示 diff；折叠时显示较短 details，避免权限框占满屏幕。
  const detailSource = request.preview ?? (request.diff && detailsExpanded ? request.diff : request.details);
  const detailLines = detailSource.split("\n");
  const lines = detailsExpanded ? detailLines.slice(0, 80) : detailLines.slice(0, 16);
  return (
    <DialogFrame
      title={<Text color={tuiColors.warning}>{request.title}</Text>}
      subtitle={`Tool: ${request.tool} · Action: ${request.actionType} · Risk: ${request.riskLevel}`}
      hint={request.requireFullYes
        ? "↑↓ navigate · Enter confirm · N deny · Ctrl+E/Ctrl+O details"
        : "↑↓ navigate · Enter select · Y execute · N deny · Ctrl+E/Ctrl+O details"}
      footer={request.requireFullYes
        ? "Approval requires the full word yes. Empty Enter or y will not execute."
        : "Press Enter to select"}
    >
      <Text> </Text>
      {request.targetPath ? <Text>Target: {request.targetPath}</Text> : null}
      {request.command ? <Text>Command: {request.command}</Text> : null}
      {request.reason ? <Text>Reason: {request.reason}</Text> : null}
      {request.changeSummary ? <Text>Summary: {request.changeSummary}</Text> : null}
      {request.requireFullYes ? (
        <>
          <Text color={tuiColors.error}>Critical or sensitive operation: review before accepting.</Text>
          <Text color={tuiColors.warning} bold>Type yes, then press Enter, to approve the selected action.</Text>
          <Text>
            Confirmation: <Text color={tuiColors.warning}>{activeInteraction.confirmation}</Text><Text color={tuiColors.warning}>█</Text>
          </Text>
          {activeInteraction.confirmationAttempted ? <Text color={tuiColors.error}>Confirmation must be the full word yes.</Text> : null}
        </>
      ) : null}
      {lines.map((line, index) => (
        <MarkdownText key={`${request.tool}-${String(index)}`} line={line} />
      ))}
      <Text> </Text>
      {permissionOptions.map((option, index) => {
        const selected = index === activeInteraction.selectedIndex;
        const color = option.dangerous ? tuiColors.error : selected ? tuiColors.warning : undefined;
        return (
          <Text key={option.choice} color={color} bold={selected} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {option.label}
            <Text color={tuiColors.textDim}>  {option.description}</Text>
          </Text>
        );
      })}
    </DialogFrame>
  );

  function moveSelection(direction: -1 | 1): void {
    setInteraction((current) => {
      const active = permissionPromptStateForRequest(current, request);
      return {
        ...active,
        selectedIndex: movePermissionSelection(active.selectedIndex, direction),
        confirmation: "",
        confirmationAttempted: false
      };
    });
  }

  function updateInteraction(update: Partial<PermissionPromptInteractionUpdate>): void {
    setInteraction((current) => ({ ...permissionPromptStateForRequest(current, request), ...update }));
  }
}

type PermissionPromptInteractionUpdate = Pick<
  ReturnType<typeof createPermissionPromptInteractionState>,
  "confirmation" | "confirmationAttempted"
>;
