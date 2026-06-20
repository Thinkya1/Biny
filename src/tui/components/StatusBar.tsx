import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  mode: "chat" | "plan";
  cwd: string;
  modelLabel: string;
}

export function StatusBar({ mode, cwd, modelLabel }: StatusBarProps): React.ReactElement {
  return (
    <Box justifyContent="space-between" width="100%">
      <Text>
        <Text>{modelLabel || "mock"}</Text>
        <Text color="gray"> · </Text>
        <Text color="green">{cwd}</Text>
      </Text>
      {mode === "plan" ? (
        <Text color="magenta">Plan mode (shift+tab to cycle)</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
