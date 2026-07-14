import React, { useMemo, useState } from "react";
import { Box, useInput } from "ink";
import type { ExpandableTranscript } from "../transcriptViewer.js";
import { stripAnsi, wrapTerminalLines } from "../terminalText.js";
import { MarkdownText } from "./MarkdownText.js";
import { DialogFrame, dialogBodyRows } from "./DialogFrame.js";

export interface TranscriptViewerProps {
  transcript: ExpandableTranscript;
  width: number;
  height: number;
  onExit: () => void;
}

export function TranscriptViewer({ transcript, width, height, onExit }: TranscriptViewerProps): React.ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const safeWidth = Math.max(1, Math.floor(width));
  const page = useMemo(
    () => transcriptViewerPage(transcript.content, safeWidth, height, scrollTop),
    [height, safeWidth, scrollTop, transcript.content]
  );
  const footer = `${String(page.safeScrollTop + 1)}-${String(Math.min(page.lines.length, page.safeScrollTop + page.bodyRows))} / ${String(page.lines.length)} visual lines`;

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (key.upArrow) {
      setScrollTop((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop((current) => Math.min(page.maxScroll, current + 1));
      return;
    }
    if (key.pageUp) {
      setScrollTop((current) => Math.max(0, current - page.bodyRows));
      return;
    }
    if (key.pageDown) {
      setScrollTop((current) => Math.min(page.maxScroll, current + page.bodyRows));
    }
  });

  return (
    <DialogFrame
      title={transcript.title}
      hint="↑↓ navigate · PgUp/PgDn page · Esc cancel"
      footer={footer}
      width={safeWidth}
      height={Math.max(1, height)}
    >
      <Box height={page.bodyRows} overflow="hidden" flexDirection="column">
        {page.visible.map((line, index) => (
          <MarkdownText key={`${String(page.safeScrollTop + index)}-${line}`} line={line} />
        ))}
      </Box>
    </DialogFrame>
  );
}

export function transcriptViewerPage(content: string, width: number, height: number, scrollTop: number): {
  lines: string[];
  visible: string[];
  bodyRows: number;
  maxScroll: number;
  safeScrollTop: number;
  showHint: boolean;
  showFooter: boolean;
} {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const showHint = safeHeight >= 3;
  const showFooter = safeHeight >= 3;
  const bodyRows = dialogBodyRows(safeHeight, { hint: true, footer: true, blankBeforeBody: true });
  const lines = wrapTerminalLines(stripAnsi(content).replaceAll("\t", "    "), safeWidth);
  const maxScroll = Math.max(0, lines.length - bodyRows);
  const safeScrollTop = Math.min(Math.max(0, Math.floor(scrollTop)), maxScroll);
  return {
    lines,
    visible: lines.slice(safeScrollTop, safeScrollTop + bodyRows),
    bodyRows,
    maxScroll,
    safeScrollTop,
    showHint,
    showFooter
  };
}
