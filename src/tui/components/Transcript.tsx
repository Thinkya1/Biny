/** Width-aware committed transcript and active-cell renderer. */
import React, { useEffect, useState } from "react";
import { Box, Static, Text } from "ink";
import { tuiColors } from "../theme/index.js";
import { visibleTranscriptRows, type TranscriptDisplayRow } from "../transcriptRows.js";
import type { TranscriptState } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface TranscriptProps {
  transcript: TranscriptState;
  width: number;
}

export function Transcript({ transcript, width }: TranscriptProps): React.ReactElement {
  const hasRunningTool = transcript.active.some((item) => item.kind === "tool" && item.status === "running");
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!hasRunningTool) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningTool]);
  return (
    <Box flexDirection="column" width="100%">
      <Static items={transcript.committed}>
        {(item) => (
          <Box key={item.id} flexDirection="column" width="100%">
            {visibleTranscriptRows({ committed: [item], active: [] }, {
              width,
              height: Number.MAX_SAFE_INTEGER,
              scrollOffset: 0,
              followLatest: true
            }).map((row) => <TranscriptRow key={row.id} row={row} />)}
          </Box>
        )}
      </Static>
      {visibleTranscriptRows({ committed: [], active: transcript.active }, {
        width,
        height: Number.MAX_SAFE_INTEGER,
        scrollOffset: 0,
        followLatest: true
      }).map((row) => <TranscriptRow key={row.id} row={row} />)}
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
    : row.itemKind === "reasoning"
      ? tuiColors.textMuted
    : row.itemKind === "error"
      ? tuiColors.error
      : notificationColor(row.tone);
  const bodyColor = row.itemKind === "user"
    ? tuiColors.textStrong
    : row.itemKind === "reasoning"
      ? tuiColors.textDim
    : row.itemKind === "error"
      ? tuiColors.error
      : row.itemKind === "notification"
        ? notificationColor(row.tone)
        : undefined;
  return (
    <Text>
      <Text color={prefixColor} bold={row.itemKind === "user" || row.itemKind === "error"}>{row.prefix}</Text>
      <MarkdownText line={row.text} muted={row.itemKind === "reasoning" || row.itemKind === "notification" && row.tone !== "warning" && row.tone !== "success"} color={bodyColor} />
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
