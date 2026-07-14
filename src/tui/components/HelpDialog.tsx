import React, { useState } from "react";
import { Text, useInput } from "ink";
import type { SlashCommand } from "../../cli/prompt/slashMenu.js";
import { DialogFrame } from "./DialogFrame.js";
import { tuiColors } from "../theme/index.js";

const pageSize = 8;

export interface HelpDialogProps {
  commands: SlashCommand[];
  message?: string;
  onExit: () => void;
}

export function HelpDialog({ commands, message, onExit }: HelpDialogProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pageStart = Math.floor(selectedIndex / pageSize) * pageSize;
  const visibleCommands = commands.slice(pageStart, pageStart + pageSize);

  useInput((_input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      setSelectedIndex((current) => commands.length ? (current + direction + commands.length) % commands.length : 0);
      return;
    }
    if (key.pageUp || key.pageDown) {
      const direction = key.pageUp ? -pageSize : pageSize;
      setSelectedIndex((current) => Math.min(Math.max(current + direction, 0), Math.max(0, commands.length - 1)));
    }
  });

  return (
    <DialogFrame
      title="Commands"
      subtitle="Type / in the composer to search and run a command."
      hint="↑↓ navigate · PgUp/PgDn page · Esc cancel"
      footer="Press esc to cancel"
    >
      <Text> </Text>
      {message ? <Text color={tuiColors.warning} wrap="truncate-end">{message}</Text> : null}
      {message ? <Text> </Text> : null}
      {visibleCommands.map((command, index) => {
        const absoluteIndex = pageStart + index;
        const selected = absoluteIndex === selectedIndex;
        return (
          <Text key={command.name} color={selected ? tuiColors.primary : tuiColors.text} bold={selected} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {String(absoluteIndex + 1)}. {command.name.padEnd(16)}
            <Text color={tuiColors.textMuted}>{command.description}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      {commands.length > pageSize ? <Text color={tuiColors.textMuted}>{`${String(selectedIndex + 1)} / ${String(commands.length)}`}</Text> : null}
    </DialogFrame>
  );
}
