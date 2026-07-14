/**
 * 历史 session 选择组件。
 *
 * `/resume` 不带参数时会进入这个独占视图。组件支持输入过滤、上下移动、回车恢复和 Esc 退出，
 * 但真正读取 session 文件的逻辑由 App 和 runtime 处理。
 */
import React from "react";
import { Text, useInput } from "ink";
import type { SessionSummary } from "../../session/events.js";
import { DialogFrame } from "./DialogFrame.js";
import { tuiColors } from "../theme/index.js";

export const sessionPickerPageSize = 6;

export interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedIndex: number;
  query: string;
  onQueryChange: (query: string) => void;
  onMove: (direction: -1 | 1) => void;
  onPageMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  onExit: () => void;
}

export function SessionPicker({ sessions, selectedIndex, query, onQueryChange, onMove, onPageMove, onSelect, onExit }: SessionPickerProps): React.ReactElement {
  useInput((input, key) => {
    // SessionPicker 是独占视图，键盘输入只用于过滤、选择或退出选择器。
    if (key.escape) {
      if (query) onQueryChange("");
      else onExit();
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
    if (key.pageUp || key.pageDown) {
      onPageMove(key.pageUp ? -1 : 1);
      return;
    }
    if (key.backspace || key.delete) {
      onQueryChange(query.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (!nextInput) return;
    onQueryChange(`${query}${nextInput}`);
  });

  const selectedPosition = Math.min(selectedIndex, Math.max(0, sessions.length - 1));
  const pageStart = Math.floor(selectedPosition / sessionPickerPageSize) * sessionPickerPageSize;
  const visibleSessions = sessions.slice(pageStart, pageStart + sessionPickerPageSize);

  return (
    <DialogFrame
      title={<>
        Select a session
        {!query ? <Text color={tuiColors.textMuted}> (type to search)</Text> : null}
      </>}
      hint={sessionHint(query, sessions.length > sessionPickerPageSize)}
      footer="Press enter to resume or esc to cancel"
    >
      <Text> </Text>
      {query ? <Text><Text color={tuiColors.primary}>Search: </Text>{query}</Text> : null}
      {sessions.length === 0 ? <Text color={tuiColors.textMuted}>No sessions yet</Text> : null}
      {visibleSessions.map((session, index) => {
        const absoluteIndex = pageStart + index;
        const selected = absoluteIndex === selectedPosition;
        const prefix = selected ? "❯ " : "  ";
        const label = `${prefix}${String(absoluteIndex + 1)}. ${preview(session.firstUserMessage)}  ${relativeTime(session.updatedAt)}`;
        return (
          <Text key={session.fileName} color={selected ? tuiColors.primary : tuiColors.text} bold={selected} wrap="truncate-end">
            {label}
          </Text>
        );
      })}
      <Text> </Text>
      {sessions.length > sessionPickerPageSize ? <Text color={tuiColors.textMuted}>{query ? `${String(selectedPosition + 1)} / ${String(sessions.length)}` : `▼ ${String(Math.max(0, sessions.length - visibleSessions.length))} more`}</Text> : null}
    </DialogFrame>
  );
}

function sessionHint(query: string, hasPages: boolean): string {
  const page = hasPages ? " · PgUp/PgDn page" : "";
  return query
    ? `↑↓ navigate${page} · Enter resume · Esc cancel · Backspace clear`
    : `↑↓ navigate${page} · Enter resume · Esc cancel`;
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
