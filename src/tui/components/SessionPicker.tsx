import React from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../../session/events.js";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedIndex: number;
  query: string;
  onQueryChange: (query: string) => void;
  onMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  onExit: () => void;
}

export function SessionPicker({ sessions, selectedIndex, query, onQueryChange, onMove, onSelect, onExit }: SessionPickerProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (key.return) {
      onSelect();
      return;
    }
    if (key.upArrow || key.downArrow) {
      onMove(key.upArrow ? -1 : 1);
      return;
    }
    if (key.backspace || key.delete) {
      onQueryChange(query.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (nextInput.length !== 1) return;
    onQueryChange(`${query}${nextInput}`);
  });

  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold>Resume a previous session</Text>
      <Text color="gray">Filter: Cwd   Sort: Updated   Search: {query || ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.length === 0 ? <Text color="gray" italic>No sessions yet</Text> : null}
        {sessions.slice(0, 12).map((session, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={session.fileName} flexDirection="column">
              <Text inverse={selected}>
                {selected ? ">" : " "}
                {" "}
                {preview(session.firstUserMessage)}
                <Text color={selected ? undefined : "gray"}>  {relativeTime(session.updatedAt)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">enter resume   esc exit   ↑/↓ browse   type filter</Text>
      </Box>
    </Box>
  );
}

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 100) || "(empty)";
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
