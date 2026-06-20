import React from "react";
import { Box, Text } from "ink";
import type { TuiToolCall } from "../types.js";

export interface ToolCallViewProps {
  toolCalls: TuiToolCall[];
  expanded: boolean;
}

export function ToolCallView({ toolCalls, expanded }: ToolCallViewProps): React.ReactElement | null {
  const visible = toolCalls.slice(-6);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>Tool Calls <Text color="gray">{expanded ? "Ctrl-O/Ctrl-D collapse" : "Ctrl-O/Ctrl-D details"}</Text></Text>
      {visible.map((call) => (
        <Box key={call.id} flexDirection="column">
          <Text color={statusColor(call.status)}>
            {statusSymbol(call.status)} {call.tool}
          </Text>
          {expanded ? <Text color="gray">  args: {call.argsSummary}</Text> : null}
          {expanded && call.resultSummary ? <Text color="gray">  result: {call.resultSummary}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function statusColor(status: TuiToolCall["status"]): string {
  if (status === "success") return "green";
  if (status === "failed") return "red";
  return "yellow";
}

function statusSymbol(status: TuiToolCall["status"]): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  return "…";
}
