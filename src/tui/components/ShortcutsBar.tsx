/** Context-sensitive shortcut hints fixed at the bottom of the TUI. */
import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../runtime/events.js";
import { terminalWidth, truncateToTerminalWidth } from "../terminalText.js";
import { tuiColors } from "../theme/index.js";

export interface ShortcutsBarProps {
  status: RuntimeStatus;
  queuedCount: number;
  mode: "chat" | "plan";
  scrolled: boolean;
  width: number;
}

export function ShortcutsBar(props: ShortcutsBarProps): React.ReactElement {
  const text = shortcutsBarText(props);
  return (
    <Box width="100%" height={1} flexShrink={0} overflow="hidden">
      <Text color={tuiColors.textMuted}>{text}</Text>
    </Box>
  );
}

export function shortcutsBarText(props: ShortcutsBarProps): string {
  const width = Math.max(1, Math.floor(props.width));
  const busy = props.status === "thinking" || props.status === "running" || props.status === "waiting_permission";
  const parts: string[] = [];
  if (props.status === "waiting_permission") {
    parts.push("waiting approval");
    parts.push("ctrl+o details");
  } else if (busy) {
    parts.push("enter queue follow-up");
    parts.push("esc stop");
    parts.push("ctrl+o details");
  } else {
    parts.push("enter send");
    parts.push("/help");
  }
  parts.push("↑/↓ history");
  parts.push("pgup/shift+↑ scroll");
  if (props.scrolled) parts.push("ctrl+g bottom");
  parts.push(props.mode === "plan" ? "shift+tab chat" : "shift+tab plan");
  return truncateToTerminalWidth(parts.join(" · "), width);
}

export function statusBarLayout(props: {
  modelLabel: string;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  contextSource?: "estimated" | "provider";
  status: RuntimeStatus;
  mode: "chat" | "plan";
  width: number;
  permissionMode?: string;
}): {
  model: string;
  context: string;
  status: string;
  gap: string;
  shortcuts: string;
} {
  // Compatibility layout for tests: info line + shortcuts combined to width.
  const width = Math.max(1, Math.floor(props.width));
  const model = props.modelLabel || "No model";
  const ctx = props.contextUsedTokens !== undefined && props.contextMaxTokens
    ? `ctx ${formatCompatContext(props.contextUsedTokens, props.contextMaxTokens, props.contextSource)}`
    : "ctx —";
  const activity = props.status === "thinking"
    ? "thinking"
    : props.status === "running"
      ? "running"
      : props.status === "waiting_permission"
        ? "waiting approval"
        : props.status === "error"
          ? "error"
          : props.status === "incomplete"
            ? "incomplete"
            : props.status === "aborted"
              ? "aborted"
              : props.status === "completed"
                ? "done"
                : props.mode === "plan"
                  ? "Plan mode"
                  : "idle";
  const context = ` · ${ctx}`;
  const status = ` · ${activity}`;
  const left = `${model}${context}${status}`;
  const shortcuts = shortcutsBarText({
    status: props.status,
    queuedCount: 0,
    mode: props.mode,
    scrolled: false,
    width: Math.max(1, width - terminalWidth(left) - 1)
  });
  const needed = terminalWidth(left) + 1 + terminalWidth(shortcuts);
  if (needed <= width) {
    return {
      model,
      context,
      status,
      gap: " ".repeat(width - terminalWidth(left) - terminalWidth(shortcuts)),
      shortcuts
    };
  }
  const compact = truncateToTerminalWidth(`${model}${context}${status}`, width);
  return { model: compact, context: "", status: "", gap: "", shortcuts: "" };
}

function formatCompatContext(used: number, max: number, source?: "estimated" | "provider"): string {
  const percent = Math.min(999, Math.max(0, Math.round((used / max) * 100)));
  return `${source === "estimated" ? "~" : ""}${String(percent)}%`;
}
