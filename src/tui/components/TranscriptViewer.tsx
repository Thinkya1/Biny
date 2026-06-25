import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { ExpandableTranscript } from "../transcriptViewer.js";
import { tuiColors } from "../theme/index.js";
import { MarkdownText } from "./MarkdownText.js";

export interface TranscriptViewerProps {
  transcript: ExpandableTranscript;
  onExit: () => void;
}

export function TranscriptViewer({ transcript, onExit }: TranscriptViewerProps): React.ReactElement {
  const { rows } = useWindowSize();
  const [scrollTop, setScrollTop] = useState(0);
  const lines = useMemo(() => transcript.content.split("\n"), [transcript.content]);
  const bodyRows = Math.max(1, rows - 6);
  const maxScroll = Math.max(0, lines.length - bodyRows);
  const safeScrollTop = Math.min(scrollTop, maxScroll);
  const visible = lines.slice(safeScrollTop, safeScrollTop + bodyRows);

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === "q") {
      onExit();
      return;
    }
    if (key.upArrow) {
      setScrollTop((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop((current) => Math.min(maxScroll, current + 1));
      return;
    }
    if (key.pageUp) {
      setScrollTop((current) => Math.max(0, current - bodyRows));
      return;
    }
    if (key.pageDown) {
      setScrollTop((current) => Math.min(maxScroll, current + bodyRows));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.borderFocus} paddingX={1} marginBottom={1}>
      <Text color={tuiColors.primary} bold>{transcript.title}</Text>
      <Text color={tuiColors.textMuted}>↑↓ navigate · PgUp/PgDn page · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => (
          <MarkdownText key={`${String(safeScrollTop + index)}-${line}`} line={line} />
        ))}
      </Box>
      <Text color={tuiColors.textMuted}>
        {String(safeScrollTop + 1)}-{String(Math.min(lines.length, safeScrollTop + bodyRows))} / {String(lines.length)}
      </Text>
    </Box>
  );
}
