/** Compact TUI title; runtime detail belongs in the footer or overlays. */
import os from "node:os";
import path from "node:path";
import React from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";

export interface HeaderProps {
  sessionId: string;
  viewingSessionId?: string;
  cwd: string;
}

export function Header({ sessionId, viewingSessionId, cwd }: HeaderProps): React.ReactElement {
  const viewingLabel = headerDisplayText(sessionId, viewingSessionId);
  return (
    <Box width="100%" height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={tuiColors.accent} bold>Biny</Text>
        <Text color={tuiColors.textMuted}> · {formatDisplayPath(cwd)}</Text>
        {viewingLabel ? <Text color={tuiColors.warning}> · {viewingLabel}</Text> : null}
      </Text>
    </Box>
  );
}

export function headerDisplayText(sessionId: string, viewingSessionId: string | undefined): string | undefined {
  if (!viewingSessionId || viewingSessionId === sessionId) return undefined;
  return `Viewing ${viewingSessionId}`;
}

export function formatDisplayPath(cwd: string, homeDirectory = os.homedir()): string {
  if (cwd === homeDirectory) return "~";
  if (!cwd.startsWith(`${homeDirectory}${path.sep}`)) return cwd;
  return `~${path.sep}${path.relative(homeDirectory, cwd)}`;
}
