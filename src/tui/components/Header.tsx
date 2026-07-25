/** Compact top bar: workspace path left, short session id right. */
import os from "node:os";
import path from "node:path";
import React from "react";
import { Box, Text } from "ink";
import { terminalWidth, truncateToTerminalWidth } from "../terminalText.js";
import { tuiColors } from "../theme/index.js";

export interface HeaderProps {
  sessionId: string;
  viewingSessionId?: string;
  cwd: string;
  width: number;
}

export function Header({ sessionId, viewingSessionId, cwd, width }: HeaderProps): React.ReactElement {
  const safeWidth = Math.max(1, Math.floor(width));
  const pathText = formatDisplayPath(cwd);
  const viewingLabel = headerDisplayText(sessionId, viewingSessionId);
  const right = shortSessionId(viewingSessionId && viewingSessionId !== sessionId ? viewingSessionId : sessionId);
  const rightWidth = terminalWidth(right);
  const gapMin = right ? 1 : 0;
  const leftBudget = Math.max(0, safeWidth - rightWidth - gapMin);

  let left = truncateToTerminalWidth(pathText, leftBudget);
  if (viewingLabel && terminalWidth(left) + 3 < leftBudget) {
    const rest = leftBudget - terminalWidth(left) - 3;
    const viewingShown = truncateToTerminalWidth(viewingLabel, rest);
    if (viewingShown) left = `${left} · ${viewingShown}`;
  }

  const gap = Math.max(0, safeWidth - terminalWidth(left) - rightWidth);

  return (
    <Box width={safeWidth} height={1} flexShrink={0} overflow="hidden">
      <Text>
        <Text color={tuiColors.textDim}>{left}</Text>
        <Text>{ " ".repeat(gap)}</Text>
        {right ? <Text color={viewingLabel ? tuiColors.warning : tuiColors.textMuted}>{right}</Text> : null}
      </Text>
    </Box>
  );
}

export function headerDisplayText(sessionId: string, viewingSessionId: string | undefined): string | undefined {
  if (!viewingSessionId || viewingSessionId === sessionId) return undefined;
  return `viewing`;
}

export function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 10) return trimmed;
  return trimmed.slice(0, 8);
}

export function formatDisplayPath(cwd: string, homeDirectory = os.homedir()): string {
  if (cwd === homeDirectory) return "~";
  if (!cwd.startsWith(`${homeDirectory}${path.sep}`)) return cwd;
  return `~${path.sep}${path.relative(homeDirectory, cwd)}`;
}
