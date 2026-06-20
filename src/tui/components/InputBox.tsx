import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  completeSlashCommand,
  createSlashMenuState,
  matchingSlashCommands,
  moveSlashSelection,
  selectedSlashCommand,
  shouldSelectSlashCommand,
  shouldShowSlashPalette,
  updateSlashQuery,
  visibleSlashRows,
  type SlashCommand,
  type SlashMenuState
} from "../../cli/prompt/slashMenu.js";

const slashMenuVisibleRows = 6;

export interface InputBoxProps {
  disabled: boolean;
  busy: boolean;
  hasToolCalls: boolean;
  slashCommands: SlashCommand[];
  initialHistory: string[];
  onSubmit: (value: string) => void;
  onHistoryAppend: (value: string) => void;
  onToggleToolDetails: () => void;
  onTogglePlanMode: () => void;
  onPreviewCommand: (commandName: string | undefined) => void;
  onExit: () => void;
}

export function InputBox({ disabled, busy, hasToolCalls, slashCommands, initialHistory, onSubmit, onHistoryAppend, onToggleToolDetails, onTogglePlanMode, onPreviewCommand, onExit }: InputBoxProps): React.ReactElement {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<SlashMenuState>(() => createSlashMenuState(slashMenuVisibleRows));
  const [menuClosed, setMenuClosed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);

  useEffect(() => {
    setHistory(initialHistory.slice(-100));
  }, [initialHistory]);

  useEffect(() => {
    if (disabled || menuClosed || !shouldShowSlashPalette(text)) {
      onPreviewCommand(undefined);
      return;
    }
    onPreviewCommand(selectedSlashCommand(menu, slashCommands)?.name);
  }, [disabled, menuClosed, menu, onPreviewCommand, slashCommands, text]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.shift && key.tab) {
      onTogglePlanMode();
      return;
    }
    if (key.meta && (key.backspace || key.delete || input === "-")) {
      updateText("");
      return;
    }
    if (key.ctrl && input.toLowerCase() === "d" && text.length === 0) {
      if (hasToolCalls) {
        onToggleToolDetails();
        return;
      }
      onExit();
      return;
    }
    if (key.escape && shouldShowSlashPalette(text)) {
      setMenuClosed(true);
      return;
    }
    if ((key.shift || key.ctrl) && (key.return || input.includes("\r") || input.includes("\n"))) {
      updateText(`${text}\n`);
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      const endIndex = firstLineBreakIndex(input);
      const beforeReturn = endIndex === -1 ? "" : input.slice(0, endIndex);
      const entered = `${text}${beforeReturn}`;
      const value = entered.trim();
      const exactCommand = slashCommands.find((command) => command.name === value.split(/\s+/)[0]);

      if (exactCommand && (!exactCommand.requiresArgs || value.split(/\s+/).length > 1)) {
        submit(value);
        return;
      }

      if (!menuClosed && shouldShowSlashPalette(entered)) {
        const nextMenu = updateSlashQuery(menu, entered);
        const selected = selectedSlashCommand(nextMenu, slashCommands);
        if (selected && shouldSelectSlashCommand(entered, selected.name, slashCommands)) {
          const next = selected.requiresArgs ? `${selected.name} ` : selected.name;
          updateText(next);
          return;
        }
      }
      if (value) submit(value);
      return;
    }
    if (key.backspace || key.delete) {
      updateText(text.slice(0, -1));
      return;
    }
    if (key.tab) {
      const next = completeSlashCommand(text, slashCommands);
      updateText(next);
      return;
    }
    if (!text && (key.upArrow || key.downArrow)) {
      recallHistory(key.upArrow ? -1 : 1);
      return;
    }
    if (!menuClosed && shouldShowSlashPalette(text) && (key.upArrow || key.downArrow)) {
      if (matchingSlashCommands(text, slashCommands).length > 0) {
        setMenu((current) => moveSlashSelection(current, slashCommands, key.upArrow ? -1 : 1));
      }
      return;
    }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    updateText(`${text}${nextInput}`);
  });

  const showMenu = !disabled && !menuClosed && shouldShowSlashPalette(text);
  const rows = showMenu ? visibleSlashRows(menu, slashCommands) : [];

  return (
    <Box flexDirection="column" width="100%">
      {showMenu ? <SlashPalette rows={rows} selected={menu.selected} /> : null}
      <Box borderStyle="single" borderColor={disabled ? "gray" : busy ? "yellow" : "green"} paddingX={1} width="100%">
        <Box flexDirection="column">
          {disabled ? (
            <Text>
              <Text color="gray">{"> "}</Text>
              <Text color="gray">waiting for permission...</Text>
            </Text>
          ) : inputLines(text).map((line, index, lines) => (
            <Text key={String(index)}>
              <Text color="green">{index === 0 ? "> " : "  "}</Text>
              <Text>{line}</Text>
              {index === lines.length - 1 ? <Text color="green">█</Text> : null}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );

  function updateText(next: string): void {
    setText(next);
    setMenu(updateSlashQuery(menu, next));
    setMenuClosed(false);
    setHistoryIndex(undefined);
  }

  function submit(value: string): void {
    onSubmit(value);
    onPreviewCommand(undefined);
    onHistoryAppend(value);
    setHistory((current) => [...current, value].slice(-100));
    setHistoryIndex(undefined);
    setText("");
    setMenu(createSlashMenuState(slashMenuVisibleRows));
    setMenuClosed(false);
  }

  function recallHistory(direction: -1 | 1): void {
    if (!history.length) return;
    const nextIndex = historyIndex === undefined
      ? direction === -1 ? history.length - 1 : 0
      : Math.min(Math.max(historyIndex + direction, 0), history.length - 1);
    const value = history[nextIndex];
    if (value === undefined) return;
    setHistoryIndex(nextIndex);
    setText(value);
    setMenu(updateSlashQuery(menu, value));
    setMenuClosed(false);
  }
}

interface SlashPaletteProps {
  rows: ReturnType<typeof visibleSlashRows>;
  selected: number;
}

function SlashPalette({ rows, selected }: SlashPaletteProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width="100%">
      {rows.length === 0 ? <Text color="gray">no matching commands</Text> : null}
      {rows.map((row, index) => {
        if (row.type === "header") {
          return <Text key={`header-${row.label}-${String(index)}`} color="gray">{row.label}</Text>;
        }
        const isSelected = row.index === selected;
        return (
          <Text key={row.command.name} inverse={isSelected}>
            {isSelected ? "> " : "  "}
            {row.command.name.padEnd(12)}
            {" "}
            <Text color={isSelected ? undefined : "gray"}>{row.command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function firstLineBreakIndex(input: string): number {
  const carriage = input.indexOf("\r");
  const newline = input.indexOf("\n");
  if (carriage === -1) return newline;
  if (newline === -1) return carriage;
  return Math.min(carriage, newline);
}

function inputLines(text: string): string[] {
  return text.split("\n");
}
