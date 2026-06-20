import React from "react";
import { Box, Text, useInput } from "ink";
import { TUI_KEYS } from "../keymap.js";
import type { PermissionChoice, TuiPermissionRequest } from "../types.js";

export interface PermissionPromptProps {
  request?: TuiPermissionRequest;
  detailsExpanded: boolean;
  onAnswer: (choice: PermissionChoice) => void;
  onToggleDetails: () => void;
}

export function PermissionPrompt({ request, detailsExpanded, onAnswer, onToggleDetails }: PermissionPromptProps): React.ReactElement | null {
  useInput((input, key) => {
    if (!request) return;
    if ((key.ctrl && input.toLowerCase() === "e") || (key.ctrl && input.toLowerCase() === "o")) onToggleDetails();
    if (input.toLowerCase() === TUI_KEYS.approve) onAnswer("approve_once");
    if (input.toLowerCase() === TUI_KEYS.reject) onAnswer("reject");
    if (input.toLowerCase() === TUI_KEYS.approveTurn) onAnswer("approve_turn");
  }, { isActive: request !== undefined });

  if (!request) return null;

  const detailSource = request.diff && detailsExpanded ? request.diff : request.details;
  const detailLines = detailSource.split("\n");
  const lines = detailsExpanded ? detailLines.slice(0, 80) : detailLines.slice(0, 16);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow" bold>{request.title}</Text>
      <Text>Tool: {request.tool}</Text>
      {request.requireFullYes ? <Text color="red">Risk: sensitive command requires explicit approval.</Text> : null}
      {lines.map((line, index) => (
        <Text key={`${request.tool}-${String(index)}`}>{line}</Text>
      ))}
      <Text color="yellow">Press y to allow, n to reject, a to allow for this turn. Ctrl-E toggles details.</Text>
    </Box>
  );
}
