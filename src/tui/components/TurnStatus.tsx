import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../runtime/events.js";

export interface TurnStatusProps {
  status: RuntimeStatus;
  turnStartedAt?: number;
  lastWorkedMs?: number;
}

export function TurnStatus({ status, turnStartedAt, lastWorkedMs }: TurnStatusProps): React.ReactElement | null {
  const label = statusLabel(status, turnStartedAt, lastWorkedMs);
  if (!label) return null;

  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color="gray">─ </Text>
      <Text color={statusColor(status, turnStartedAt)}>{label}</Text>
      <Text color="gray"> ─────────────────────────────────────────────────────────────</Text>
    </Box>
  );
}

function statusLabel(status: RuntimeStatus, turnStartedAt?: number, lastWorkedMs?: number): string | undefined {
  if (turnStartedAt !== undefined && status !== "idle" && status !== "completed" && status !== "error") return "working";
  if (status === "completed" && lastWorkedMs !== undefined) return `worked for ${formatDuration(lastWorkedMs)}`;
  if (status === "error") return "error";
  return undefined;
}

function statusColor(status: RuntimeStatus, turnStartedAt?: number): string {
  if (turnStartedAt !== undefined && status !== "idle" && status !== "completed" && status !== "error") return "cyan";
  if (status === "error") return "red";
  return "gray";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(rest)}s`;
}
