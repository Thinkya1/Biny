/** Width-aware committed transcript and active-cell renderer. */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";
import { visibleTranscriptRows, type TranscriptDisplayRow } from "../transcriptRows.js";
import type { TranscriptState } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface TranscriptProps {
  transcript: TranscriptState;
  width: number;
  height: number;
  scrollOffset: number;
  followLatest: boolean;
  expandedToolId?: string;
}

export function Transcript({ transcript, width, height, scrollOffset, followLatest, expandedToolId }: TranscriptProps): React.ReactElement {
  const hasRunningTool = transcript.active.some((item) => item.kind === "tool" && item.status === "running");
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!hasRunningTool) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningTool]);
  const rows = visibleTranscriptRows(transcript, {
    width,
    height,
    scrollOffset,
    followLatest,
    expandedToolId
  });
  return (
    <Box flexDirection="column" justifyContent="flex-end" width="100%" height={Math.max(0, height)} overflow="hidden">
      {rows.map((row) => <TranscriptRow key={row.id} row={row} />)}
    </Box>
  );
}

function TranscriptRow({ row }: { row: TranscriptDisplayRow }): React.ReactElement {
  if (row.kind === "spacer") return <Text> </Text>;
  if (row.kind === "tool-title") {
    return (
      <Text>
        <Text color={toolStatusColor(row.status)}>{row.marker}</Text>
        <Text bold>{row.title}</Text>
        <Text color={tuiColors.textMuted}>{row.gap}{row.duration}</Text>
      </Text>
    );
  }
  if (row.kind === "tool-output") {
    const color = row.omitted
      ? tuiColors.textMuted
      : row.status === "failed" || row.status === "denied"
        ? tuiColors.error
        : tuiColors.textDim;
    return (
      <Text color={color}>
        {row.prefix}<MarkdownText line={row.text} muted={false} color={color} />
      </Text>
    );
  }

  const prefixColor = row.itemKind === "user"
    ? tuiColors.accent
    : row.itemKind === "error"
      ? tuiColors.error
      : notificationColor(row.tone);
  const bodyColor = row.itemKind === "user"
    ? tuiColors.textStrong
    : row.itemKind === "error"
      ? tuiColors.error
      : row.itemKind === "notification"
        ? notificationColor(row.tone)
        : undefined;
  return (
    <Text>
      <Text color={prefixColor} bold={row.itemKind === "user" || row.itemKind === "error"}>{row.prefix}</Text>
      <MarkdownText line={row.text} muted={row.itemKind === "notification" && row.tone !== "warning" && row.tone !== "success"} color={bodyColor} />
    </Text>
  );
}

function toolStatusColor(status: Extract<TranscriptDisplayRow, { kind: "tool-title" }>["status"]): string {
  if (status === "success") return tuiColors.success;
  if (status === "failed" || status === "denied") return tuiColors.error;
  if (status === "running") return tuiColors.accent;
  if (status === "pending") return tuiColors.warning;
  return tuiColors.textMuted;
}

function notificationColor(tone: Extract<TranscriptDisplayRow, { kind: "message" }>["tone"]): string {
  if (tone === "success") return tuiColors.success;
  if (tone === "warning") return tuiColors.warning;
  return tuiColors.textMuted;
}
