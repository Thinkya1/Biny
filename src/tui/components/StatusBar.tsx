/** Single-line footer for model, context usage, runtime state and shortcuts. */
import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../runtime/events.js";
import { terminalWidth, truncateToTerminalWidth } from "../terminalText.js";
import { tuiColors } from "../theme/index.js";

export interface StatusBarProps {
  modelLabel: string;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  status: RuntimeStatus;
  mode: "chat" | "plan";
  width: number;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const layout = statusBarLayout(props);
  return (
    <Box width="100%" height={1} flexShrink={0}>
      <Text color={tuiColors.accent}>{layout.model}</Text>
      <Text color={tuiColors.textMuted}>{layout.context}</Text>
      <Text color={statusColor(props.status)}>{layout.status}</Text>
      <Text color={tuiColors.textMuted}>{layout.gap}{layout.shortcuts}</Text>
    </Box>
  );
}

export function statusBarLayout(props: StatusBarProps): {
  model: string;
  context: string;
  status: string;
  gap: string;
  shortcuts: string;
} {
  const width = Math.max(1, Math.floor(props.width));
  const model = props.modelLabel || "No model";
  const contextLabel = `ctx ${formatContextUsage(props.contextUsedTokens, props.contextMaxTokens)}`;
  const statusLabel = runtimeStatusLabel(props.status, props.mode);
  const context = ` · ${contextLabel}`;
  const status = ` · ${statusLabel}`;
  const left = `${model}${context}${status}`;
  const shortcuts = props.status === "thinking" || props.status === "running" || props.status === "waiting_permission"
    ? "esc stop · ctrl+o details"
    : "ctrl+o details · pgup scroll · shift+tab mode";
  const needed = terminalWidth(left) + 1 + terminalWidth(shortcuts);
  if (needed <= width) {
    return { model, context, status, gap: " ".repeat(width - terminalWidth(left) - terminalWidth(shortcuts)), shortcuts };
  }
  const compactSuffix = `${contextLabel} · ${statusLabel}`;
  const suffixWidth = terminalWidth(compactSuffix);
  if (suffixWidth <= width) {
    const modelWidth = Math.max(0, width - suffixWidth - 3);
    const compactModel = modelWidth > 0 ? truncateToTerminalWidth(model, modelWidth) : "";
    return {
      model: compactModel,
      context: compactModel ? ` · ${contextLabel}` : contextLabel,
      status: ` · ${statusLabel}`,
      gap: "",
      shortcuts: ""
    };
  }
  return {
    model: "",
    context: "",
    status: truncateToTerminalWidth(statusLabel, width),
    gap: "",
    shortcuts: ""
  };
}

export function formatContextUsage(used: number | undefined, max: number | undefined): string {
  if (used === undefined || max === undefined || max <= 0) return "—";
  const percent = Math.min(999, Math.max(0, Math.round((used / max) * 100)));
  return `${String(percent)}%`;
}

function runtimeStatusLabel(status: RuntimeStatus, mode: "chat" | "plan"): string {
  if (status === "thinking") return "thinking";
  if (status === "running") return "running";
  if (status === "waiting_permission") return "waiting approval";
  if (status === "error") return "error";
  if (status === "completed") return "done";
  return mode === "plan" ? "plan" : "idle";
}

function statusColor(status: RuntimeStatus): string {
  if (status === "error") return tuiColors.error;
  if (status === "waiting_permission") return tuiColors.warning;
  if (status === "completed") return tuiColors.success;
  if (status === "thinking" || status === "running") return tuiColors.accent;
  return tuiColors.textMuted;
}
