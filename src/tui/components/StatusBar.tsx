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
  contextSource?: "estimated" | "provider";
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
  const contextLabel = `ctx ${formatContextUsage(props.contextUsedTokens, props.contextMaxTokens, props.contextSource)}`;
  const statusLabel = runtimeStatusLabel(props.status, props.mode);
  const context = ` · ${contextLabel}`;
  const status = ` · ${statusLabel}`;
  const left = `${model}${context}${status}`;
  const modeShortcut = props.mode === "plan" ? "shift+tab to cycle" : "shift+tab plan mode";
  const shortcuts = props.status === "thinking" || props.status === "running" || props.status === "waiting_permission"
    ? `esc stop · ctrl+o details · ${modeShortcut}`
    : `ctrl+o details · ${modeShortcut}`;
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

export function formatContextUsage(used: number | undefined, max: number | undefined, source?: "estimated" | "provider"): string {
  if (used === undefined || max === undefined || max <= 0) return "—";
  const percent = Math.min(999, Math.max(0, Math.round((used / max) * 100)));
  return `${source === "estimated" ? "~" : ""}${String(percent)}%`;
}

function runtimeStatusLabel(status: RuntimeStatus, mode: "chat" | "plan"): string {
  const activity = status === "thinking"
    ? "thinking"
    : status === "running"
      ? "running"
      : status === "waiting_permission"
        ? "waiting approval"
        : status === "error"
          ? "error"
          : status === "completed"
            ? "done"
            : "idle";
  if (mode !== "plan") return activity;
  return activity === "idle" ? "Plan mode" : `${activity} · Plan mode`;
}

function statusColor(status: RuntimeStatus): string {
  if (status === "error") return tuiColors.error;
  if (status === "waiting_permission") return tuiColors.warning;
  if (status === "completed") return tuiColors.success;
  if (status === "thinking" || status === "running") return tuiColors.accent;
  return tuiColors.textMuted;
}
