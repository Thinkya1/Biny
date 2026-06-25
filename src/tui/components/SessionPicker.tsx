/**
 * 历史 session 选择组件。
 *
 * `/resume` 不带参数时会进入这个独占视图。组件支持输入过滤、上下移动、回车恢复和 Esc 退出，
 * 但真正读取 session 文件的逻辑由 App 和 runtime 处理。
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../../session/events.js";
import { tuiColors } from "../theme/index.js";

export interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedIndex: number;
  query: string;
  onQueryChange: (query: string) => void;
  onMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  onExit: () => void;
}

export function SessionPicker({ sessions, selectedIndex, query, onQueryChange, onMove, onSelect, onExit }: SessionPickerProps): React.ReactElement {
  useInput((input, key) => {
    // SessionPicker 是独占视图，键盘输入只用于过滤、选择或退出选择器。
    if (key.escape) {
      onExit();
      return;
    }
    if (key.return) {
      onSelect();
      return;
    }
    if (key.upArrow || key.downArrow) {
      onMove(key.upArrow ? -1 : 1);
      return;
    }
    if (key.backspace || key.delete) {
      onQueryChange(query.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (nextInput.length !== 1) return;
    onQueryChange(`${query}${nextInput}`);
  });

  return (
    <Box flexDirection="column" width="100%">
      <Text color={tuiColors.primary} bold>Resume a previous session</Text>
      <Text color={tuiColors.textDim}>Filter: Cwd   Sort: Updated   Search: {query || ""}</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.length === 0 ? <Text color={tuiColors.textDim} italic>No sessions yet</Text> : null}
        {sessions.slice(0, 12).map((session, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={session.fileName} flexDirection="column">
              <Text inverse={selected}>
                {selected ? ">" : " "}
                {" "}
                {preview(session.firstUserMessage)}
                <Text color={selected ? undefined : tuiColors.textDim}>  {relativeTime(session.updatedAt)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={tuiColors.textDim}>enter resume   esc exit   ↑/↓ browse   type filter</Text>
      </Box>
    </Box>
  );
}

function preview(value: string): string {
  // 会话列表只展示首条用户消息的短预览，避免长任务撑破一行。
  return value.replace(/\s+/g, " ").trim().slice(0, 100) || "(empty)";
}

function relativeTime(value: string): string {
  // 相对时间只用于界面提示，不影响排序；排序在传入 sessions 前完成。
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
