/** Width-aware committed transcript and active-cell renderer. */
import React, { memo, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";
import {
  sliceTranscriptRows,
  transcriptRowsForDisplay,
  type TranscriptDisplayRow
} from "../transcriptRows.js";
import type { TranscriptState } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface TranscriptProps {
  transcript: TranscriptState;
  width: number;
  height?: number;
  scrollOffset?: number;
  followLatest?: boolean;
  expandedIds?: ReadonlySet<string>;
  /** Precomputed layout rows from App; avoids re-wrapping on every scroll tick. */
  layoutRows?: readonly TranscriptDisplayRow[];
}

export function Transcript({
  transcript,
  width,
  height,
  scrollOffset = 0,
  followLatest = true,
  expandedIds,
  layoutRows
}: TranscriptProps): React.ReactElement {
  const hasRunning = transcript.active.some((item) =>
    (item.kind === "tool" && item.status === "running")
    || (item.kind === "reasoning" && item.startedAtMs !== undefined)
  );
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  // 布局（wrap）只在内容/宽度变化时重建；滚动只做 slice。
  const allRows = useMemo(() => {
    if (layoutRows) return layoutRows;
    return transcriptRowsForDisplay(transcript, width, undefined, expandedIds);
  }, [expandedIds, layoutRows, transcript, width]);

  const rows = useMemo(() => sliceTranscriptRows(allRows, {
    height: height ?? Number.MAX_SAFE_INTEGER,
    scrollOffset,
    followLatest
  }), [allRows, followLatest, height, scrollOffset]);

  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      {rows.map((row) => <TranscriptRow key={row.id} row={row} />)}
    </Box>
  );
}

const TranscriptRow = memo(function TranscriptRow({ row }: { row: TranscriptDisplayRow }): React.ReactElement {
  if (row.kind === "spacer") return <Text> </Text>;
  if (row.kind === "tool-title" || row.kind === "block-header") {
    const status = row.kind === "tool-title" ? row.status : row.status;
    const titleColor = row.kind === "block-header" && row.block === "thinking"
      ? tuiColors.accentThinking
      : undefined;
    return (
      <Text>
        <Text color={toolStatusColor(status, row.kind === "block-header" ? row.block : "tool")}>{row.marker}</Text>
        <Text bold color={titleColor}>{row.title}</Text>
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
        {row.prefix}<PlainOrMarkdown line={row.text} color={color} />
      </Text>
    );
  }

  const prefixColor = row.itemKind === "user"
    ? tuiColors.roleUser
    : row.itemKind === "reasoning"
      ? tuiColors.accentThinking
    : row.itemKind === "error"
      ? tuiColors.error
      : notificationColor(row.tone);
  const bodyColor = row.itemKind === "user"
    ? tuiColors.textStrong
    : row.itemKind === "reasoning"
      ? tuiColors.textDim
    : row.itemKind === "error"
      ? tuiColors.error
    : row.itemKind === "assistant"
      ? tuiColors.text
    : row.itemKind === "notification"
        ? notificationColor(row.tone)
        : undefined;
  const muted = row.itemKind === "reasoning"
    || (row.itemKind === "notification" && row.tone !== "warning" && row.tone !== "success");
  return (
    <Text>
      <Text color={prefixColor} bold={row.itemKind === "user" || row.itemKind === "error"}>{row.prefix}</Text>
      <PlainOrMarkdown line={row.text} muted={muted} color={bodyColor} />
    </Text>
  );
});

/** Skip markdown parse for plain lines — major cost when scrolling dense history. */
const PlainOrMarkdown = memo(function PlainOrMarkdown({
  line,
  muted,
  color
}: {
  line: string;
  muted?: boolean;
  color?: string;
}): React.ReactElement {
  if (isPlainTranscriptLine(line)) {
    return <Text color={color ?? (muted ? tuiColors.textDim : tuiColors.text)}>{line}</Text>;
  }
  return <MarkdownText line={line} muted={muted} color={color} />;
});

function isPlainTranscriptLine(line: string): boolean {
  // No markdown/diff markers worth parsing.
  return !/[`*_#<>|]/.test(line)
    && !line.startsWith("+")
    && !line.startsWith("-")
    && !line.startsWith("@@")
    && !line.includes("**");
}

function toolStatusColor(
  status: Extract<TranscriptDisplayRow, { kind: "tool-title" }>["status"] | undefined,
  block: "thinking" | "tool"
): string {
  if (block === "thinking") return tuiColors.accentThinking;
  if (status === "success") return tuiColors.success;
  if (status === "failed" || status === "denied") return tuiColors.error;
  if (status === "running") return tuiColors.accentRunning;
  if (status === "pending") return tuiColors.warning;
  return tuiColors.accentTool;
}

function notificationColor(tone: Extract<TranscriptDisplayRow, { kind: "message" }>["tone"]): string {
  if (tone === "success") return tuiColors.success;
  if (tone === "warning") return tuiColors.warning;
  return tuiColors.textMuted;
}
