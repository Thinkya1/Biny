/** Initial empty-state welcome card for a newly opened TUI session. */
import React from "react";
import { Box, Text } from "ink";
import { truncateToTerminalWidth } from "../terminalText.js";
import { tuiColors } from "../theme/index.js";

const pixelCat = [
  "      ████    ████",
  "      ████    ████",
  "   ████████████████████",
  "   ████  ████  ████  ████",
  "   ██████████████████████",
  "    ████████████████████",
  "     ████  ████  ████",
  "     ████  ████  ████"
] as const;

export interface WelcomeProps {
  cwd: string;
  width?: number;
}

export function Welcome({ cwd, width }: WelcomeProps): React.ReactElement {
  // 边框 + paddingX 各占 2 列，正文可用宽度再减 4。
  const innerWidth = width !== undefined ? Math.max(8, Math.floor(width) - 4) : undefined;
  const line = (value: string): string => (innerWidth === undefined ? value : truncateToTerminalWidth(value, innerWidth));
  return (
    <Box
      borderStyle="round"
      borderColor={tuiColors.promptBorderFocus}
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      width="100%"
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text color={tuiColors.primary} bold>Biny is ready</Text>
        <Text color={tuiColors.textMuted}> · your local coding assistant</Text>
      </Text>
      <Text> </Text>
      {pixelCat.map((row, index) => (
        <Text key={`pixel-cat-${String(index)}`} color={tuiColors.primary} bold wrap="truncate-end">
          {line(row)}
        </Text>
      ))}
      <Text> </Text>
      <Text color={tuiColors.textMuted} wrap="truncate-end">{line("A small cat is here to help.")}</Text>
      <Text color={tuiColors.textMuted} wrap="truncate-end">{line(`Workspace · ${cwd}`)}</Text>
      <Text color={tuiColors.textMuted} wrap="truncate-end">{line("Type a task to begin · /help for commands")}</Text>
    </Box>
  );
}
