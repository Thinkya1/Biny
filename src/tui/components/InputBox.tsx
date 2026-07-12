/**
 * TUI 输入框组件。
 *
 * 这个组件维护正在编辑的文本、历史记录游标和 slash 菜单状态，处理多行输入、Tab 补全、
 * Shift+Tab 切换 plan 模式以及 Ctrl-D 等快捷键。提交后的业务分发由 App 完成。
 */
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
import { editInputText, inputLineSegments, type InputEditAction } from "../inputEditing.js";
import { tuiColors } from "../theme/index.js";

const slashMenuVisibleRows = 6;

export interface InputBoxProps {
  // disabled 表示权限等待中；busy 表示 agent 正在思考或执行工具。
  disabled: boolean;
  disabledPlaceholder?: string;
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

export function InputBox({ disabled, disabledPlaceholder, busy, hasToolCalls, slashCommands, initialHistory, onSubmit, onHistoryAppend, onToggleToolDetails, onTogglePlanMode, onPreviewCommand, onExit }: InputBoxProps): React.ReactElement {
  // InputBox 自己维护正在编辑的文本、slash 菜单状态和本地历史游标。
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<SlashMenuState>(() => createSlashMenuState(slashMenuVisibleRows));
  const [menuClosed, setMenuClosed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);

  useEffect(() => {
    // 外部历史加载完成后同步到组件，最多保留 100 条。
    setHistory(initialHistory.slice(-100));
  }, [initialHistory]);

  useEffect(() => {
    // 当 slash 菜单选中 /plan 时通知 App 预览 plan 模式状态栏。
    if (disabled || menuClosed || !shouldShowSlashPalette(text)) {
      onPreviewCommand(undefined);
      return;
    }
    onPreviewCommand(selectedSlashCommand(menu, slashCommands)?.name);
  }, [disabled, menuClosed, menu, onPreviewCommand, slashCommands, text]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.shift && key.tab) {
      // Shift+Tab 在 chat/plan 模式间切换。
      onTogglePlanMode();
      return;
    }
    if (key.meta && (key.backspace || key.delete || input === "-")) {
      // Option+Backspace 在不同终端里可能表现不同，这里统一当作清空输入。
      updateText("");
      return;
    }
    if (key.ctrl && input.toLowerCase() === "d" && text.length === 0) {
      // 空输入时 Ctrl-D 优先切换工具详情；没有工具调用时退出 TUI。
      if (hasToolCalls) {
        onToggleToolDetails();
        return;
      }
      onExit();
      return;
    }
    if (key.ctrl && input.toLowerCase() === "a") {
      applyEdit({ type: "line-start" });
      return;
    }
    if (key.ctrl && input.toLowerCase() === "e") {
      applyEdit({ type: "line-end" });
      return;
    }
    if (key.ctrl && input.toLowerCase() === "u") {
      applyEdit({ type: "delete-before" });
      return;
    }
    if (key.ctrl && input.toLowerCase() === "k") {
      applyEdit({ type: "delete-after" });
      return;
    }
    if (key.escape && shouldShowSlashPalette(text)) {
      // Esc 只关闭当前 slash 菜单，不清空已输入命令。
      setMenuClosed(true);
      return;
    }
    if ((key.shift || key.ctrl) && (key.return || input.includes("\r") || input.includes("\n"))) {
      // Shift/Ctrl+Enter 插入换行，普通 Enter 才提交。
      applyEdit({ type: "insert", value: "\n" });
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      // 某些终端会把回车放在 input 字符串里，所以同时检查 key 和内容。
      const endIndex = firstLineBreakIndex(input);
      const beforeReturn = endIndex === -1 ? "" : input.slice(0, endIndex);
      const enteredState = beforeReturn
        ? editInputText({ text, cursor }, { type: "insert", value: beforeReturn })
        : { text, cursor };
      const entered = enteredState.text;
      const value = entered.trim();
      const exactCommand = slashCommands.find((command) => command.name === value.split(/\s+/)[0]);

      if (exactCommand && (!exactCommand.requiresArgs || value.split(/\s+/).length > 1)) {
        submit(value);
        return;
      }

      if (!menuClosed && shouldShowSlashPalette(entered)) {
        // 在 slash 菜单打开时按 Enter 会先补全选中命令，必要时继续等待参数。
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
    if (key.backspace) {
      applyEdit({ type: "backspace" });
      return;
    }
    if (key.delete) {
      applyEdit({ type: "delete" });
      return;
    }
    if (key.home) {
      applyEdit({ type: "line-start" });
      return;
    }
    if (key.end) {
      applyEdit({ type: "line-end" });
      return;
    }
    if (key.leftArrow) {
      applyEdit({ type: "move-left" });
      return;
    }
    if (key.rightArrow) {
      applyEdit({ type: "move-right" });
      return;
    }
    if (key.tab) {
      // Tab 触发公共 slash 补全逻辑。
      const next = completeSlashCommand(text, slashCommands);
      updateText(next);
      return;
    }
    if (!text && (key.upArrow || key.downArrow)) {
      // 输入框为空时，上下键在历史记录中移动。
      recallHistory(key.upArrow ? -1 : 1);
      return;
    }
    if (!menuClosed && shouldShowSlashPalette(text) && (key.upArrow || key.downArrow)) {
      // slash 菜单打开时，上下键移动菜单选中项。
      if (matchingSlashCommands(text, slashCommands).length > 0) {
        setMenu((current) => moveSlashSelection(current, slashCommands, key.upArrow ? -1 : 1));
      }
      return;
    }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (nextInput) applyEdit({ type: "insert", value: nextInput });
  });

  const showMenu = !disabled && !menuClosed && shouldShowSlashPalette(text);
  const rows = showMenu ? visibleSlashRows(menu, slashCommands) : [];

  return (
    <Box flexDirection="column" width="100%">
      {showMenu ? <SlashPalette rows={rows} selected={menu.selected} /> : null}
      <Box borderStyle="single" borderColor={disabled ? tuiColors.border : busy ? tuiColors.warning : tuiColors.primary} paddingX={1} width="100%">
        <Box flexDirection="column">
          {disabled ? (
            <Text>
              <Text color={tuiColors.textDim}>{"> "}</Text>
              <Text color={tuiColors.textDim}>{disabledPlaceholder ?? "waiting for permission..."}</Text>
            </Text>
          ) : inputLineSegments(text, cursor).map((line, index) => (
            <Text key={String(index)}>
              <Text color={tuiColors.primary}>{line.prefix}</Text>
              <Text>{line.before}</Text>
              {line.hasCursor ? <Text color={tuiColors.primary}>█</Text> : null}
              <Text>{line.after}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );

  function updateText(next: string, nextCursor = next.length): void {
    // 每次文本变化都刷新 slash 查询，并重置历史游标。
    setText(next);
    setCursor(Math.min(Math.max(nextCursor, 0), next.length));
    setMenu(updateSlashQuery(menu, next));
    setMenuClosed(false);
    setHistoryIndex(undefined);
  }

  function applyEdit(action: InputEditAction): void {
    const next = editInputText({ text, cursor }, action);
    updateText(next.text, next.cursor);
  }

  function submit(value: string): void {
    // 提交后清空输入框、关闭菜单，并把内容同步到内存和磁盘历史。
    onSubmit(value);
    onPreviewCommand(undefined);
    onHistoryAppend(value);
    setHistory((current) => [...current, value].slice(-100));
    setHistoryIndex(undefined);
    setText("");
    setCursor(0);
    setMenu(createSlashMenuState(slashMenuVisibleRows));
    setMenuClosed(false);
  }

  function recallHistory(direction: -1 | 1): void {
    // 历史游标在 [0, history.length - 1] 内夹紧，不做循环。
    if (!history.length) return;
    const nextIndex = historyIndex === undefined
      ? direction === -1 ? history.length - 1 : 0
      : Math.min(Math.max(historyIndex + direction, 0), history.length - 1);
    const value = history[nextIndex];
    if (value === undefined) return;
    setHistoryIndex(nextIndex);
    setText(value);
    setCursor(value.length);
    setMenu(updateSlashQuery(menu, value));
    setMenuClosed(false);
  }
}

interface SlashPaletteProps {
  rows: ReturnType<typeof visibleSlashRows>;
  selected: number;
}

function SlashPalette({ rows, selected }: SlashPaletteProps): React.ReactElement {
  // SlashPalette 只负责展示 rows；过滤和选中状态由 slashMenu 工具函数维护。
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.border} paddingX={1} width="100%">
      {rows.length === 0 ? <Text color={tuiColors.textDim}>no matching commands</Text> : null}
      {rows.map((row, index) => {
        if (row.type === "header") {
          return <Text key={`header-${row.label}-${String(index)}`} color={tuiColors.textDim}>{row.label}</Text>;
        }
        const isSelected = row.index === selected;
        return (
          <Text key={row.command.name} inverse={isSelected}>
            {isSelected ? "> " : "  "}
            {row.command.name.padEnd(12)}
            {" "}
            <Text color={isSelected ? undefined : tuiColors.textDim}>{row.command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function firstLineBreakIndex(input: string): number {
  // 兼容 \r、\n 和 \r\n，返回最早出现的换行位置。
  const carriage = input.indexOf("\r");
  const newline = input.indexOf("\n");
  if (carriage === -1) return newline;
  if (newline === -1) return carriage;
  return Math.min(carriage, newline);
}
