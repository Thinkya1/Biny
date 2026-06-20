import React from "react";
import { Box, Text } from "ink";

export interface HeaderProps {
  sessionId: string;
  viewingSessionId?: string;
}

export function Header({ sessionId, viewingSessionId }: HeaderProps): React.ReactElement {
  const viewing = viewingSessionId && viewingSessionId !== sessionId ? `Viewing: ${viewingSessionId}` : undefined;
  return (
    <Box width="100%" marginBottom={1}>
      <Text>
        <Text bold>Biny</Text>
        <Text color="gray">  </Text>
        <Text color="gray">{sessionId || "(starting)"}</Text>
        {viewing ? <Text color="yellow">  {viewing}</Text> : null}
      </Text>
    </Box>
  );
}
