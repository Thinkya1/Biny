/** Single-line metadata under the prompt: model · mode · permission · context. */
import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import type { RuntimeStatus } from "../../runtime/events.js";
import { terminalWidth, truncateToTerminalWidth } from "../terminalText.js";
import { tuiColors } from "../theme/index.js";

export interface PromptInfoProps {
  modelLabel: string;
  permissionMode: PermissionMode;
  mode: "chat" | "plan";
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  contextSource?: "estimated" | "provider";
  status: RuntimeStatus;
  queuedCount: number;
  width: number;
}

export function PromptInfo(props: PromptInfoProps): React.ReactElement {
  const layout = promptInfoLayout(props);
  return (
    <Box width="100%" height={1} flexShrink={0} overflow="hidden">
      <Text color={tuiColors.accent}>{layout.model}</Text>
      <Text color={tuiColors.textMuted}>{layout.meta}</Text>
      <Text color={statusColor(props.status)}>{layout.status}</Text>
    </Box>
  );
}

export function promptInfoLayout(props: PromptInfoProps): {
  model: string;
  meta: string;
  status: string;
} {
  const width = Math.max(1, Math.floor(props.width));
  const model = props.modelLabel || "No model";
  const parts: string[] = [];
  parts.push(props.permissionMode);
  if (props.mode === "plan") parts.push("plan");
  const ctx = formatContextUsage(props.contextUsedTokens, props.contextMaxTokens, props.contextSource);
  if (ctx !== "—") parts.push(`ctx ${ctx}`);
  const meta = parts.length ? ` · ${parts.join(" · ")}` : "";
  const activity = runtimeStatusLabel(props.status);
  const queue = props.queuedCount > 0 ? `queued ${String(props.queuedCount)}` : "";
  const statusParts = [activity !== "idle" ? activity : "", queue].filter(Boolean);
  const status = statusParts.length ? ` · ${statusParts.join(" · ")}` : "";

  const full = `${model}${meta}${status}`;
  if (terminalWidth(full) <= width) {
    return { model, meta, status };
  }

  const compact = truncateToTerminalWidth(full, width);
  return { model: compact, meta: "", status: "" };
}

export function formatContextUsage(used: number | undefined, max: number | undefined, source?: "estimated" | "provider"): string {
  if (used === undefined || max === undefined || max <= 0) return "—";
  const percent = Math.min(999, Math.max(0, Math.round((used / max) * 100)));
  return `${source === "estimated" ? "~" : ""}${String(percent)}%`;
}

function runtimeStatusLabel(status: RuntimeStatus): string {
  if (status === "thinking") return "thinking";
  if (status === "running") return "running";
  if (status === "waiting_permission") return "waiting approval";
  if (status === "error") return "error";
  if (status === "incomplete") return "incomplete";
  if (status === "aborted") return "aborted";
  if (status === "completed") return "done";
  return "idle";
}

function statusColor(status: RuntimeStatus): string {
  if (status === "error") return tuiColors.error;
  if (status === "incomplete" || status === "aborted" || status === "waiting_permission") return tuiColors.warning;
  if (status === "completed") return tuiColors.success;
  if (status === "thinking" || status === "running") return tuiColors.accentRunning;
  return tuiColors.textMuted;
}
