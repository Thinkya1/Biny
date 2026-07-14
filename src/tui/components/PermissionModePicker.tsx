import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import {
  movePermissionModeSelection,
  permissionModeOptionIndex,
  permissionModeOptions
} from "../permissionModeOptions.js";
import { DialogFrame } from "./DialogFrame.js";
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
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <DialogFrame
      title="Select Permission Mode"
      hint="↑↓ navigate · Enter select · Esc cancel"
      footer="Press enter to select or esc to cancel"
    >
      <Text> </Text>
      {permissionModeOptions.map((option, index) => {
        const selected = index === selectedIndex;
        const current = option.mode === currentMode;
        return (
          <Text key={option.mode} color={selected ? tuiColors.primary : tuiColors.text} bold={selected} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {String(index + 1)}. {option.label}
            <Text color={tuiColors.textMuted}>  {option.description}</Text>
            {current ? <Text color={tuiColors.success}> ← current</Text> : null}
          </Text>
        );
      })}
    </DialogFrame>
  );
}
