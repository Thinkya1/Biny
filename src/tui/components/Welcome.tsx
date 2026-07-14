/** Initial empty-state welcome card for a newly opened TUI session. */
import React from "react";
import { Box, Text } from "ink";
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
}

export function Welcome({ cwd }: WelcomeProps): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={tuiColors.border}
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      width="100%"
    >
      <Text>
        <Text color={tuiColors.accent} bold>Biny is ready</Text>
        <Text color={tuiColors.textMuted}> · your local desktop assistant</Text>
      </Text>
      <Text> </Text>
      {pixelCat.map((line, index) => <Text key={`pixel-cat-${String(index)}`} color={tuiColors.accent} bold>{line}</Text>)}
      <Text> </Text>
      <Text color={tuiColors.textMuted}>A small cat is here to help.</Text>
      <Text color={tuiColors.textMuted}>Workspace · {cwd}</Text>
      <Text color={tuiColors.textMuted}>Type a task to begin · /help for commands</Text>
    </Box>
  );
}
