import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import {
  movePermissionModeSelection,
  permissionModeOptionIndex,
  permissionModeOptions
} from "../permissionModeOptions.js";
import { tuiColors } from "../theme/index.js";

export interface PermissionModePickerProps {
  currentMode: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
  onCancel: () => void;
}

export function PermissionModePicker({ currentMode, onSelect, onCancel }: PermissionModePickerProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(permissionModeOptionIndex(currentMode));

  useEffect(() => {
    setSelectedIndex(permissionModeOptionIndex(currentMode));
  }, [currentMode]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((current) => movePermissionModeSelection(current, -1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => movePermissionModeSelection(current, 1));
      return;
    }
    if (key.return) {
      const option = permissionModeOptions[selectedIndex];
      if (option) onSelect(option.mode);
      return;
    }
    if (key.escape || input.toLowerCase() === "q") {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.borderFocus} paddingX={1} marginBottom={1}>
      <Text color={tuiColors.primary} bold>Update Model Permissions</Text>
      <Text color={tuiColors.textMuted}>↑↓ navigate · Enter select · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {permissionModeOptions.map((option, index) => {
          const selected = index === selectedIndex;
          const current = option.mode === currentMode;
          return (
            <Box key={option.mode} flexDirection="column">
              <Text color={selected ? tuiColors.primary : tuiColors.text} bold={selected}>
                {selected ? "❯ " : "  "}
                {String(index + 1)}. {option.label}
                {current ? <Text color={tuiColors.success}> ← current</Text> : null}
              </Text>
              <Text color={tuiColors.textMuted}>    {option.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
