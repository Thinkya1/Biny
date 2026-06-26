/**
 * 工具调用视图组件。
 *
 * 这里展示最近几条工具调用的状态，折叠时只显示工具名和成功/失败状态，展开时显示参数和结果摘要。
 * 完整工具事件仍保存在 session JSONL 中。
 */
import React from "react";
import { Box, Text } from "ink";
import { tuiColors } from "../theme/index.js";
import type { TuiToolCall } from "../types.js";
import { MarkdownText } from "./MarkdownText.js";

export interface ToolCallViewProps {
  toolCalls: TuiToolCall[];
  expanded: boolean;
}

export function ToolCallView({ toolCalls, expanded }: ToolCallViewProps): React.ReactElement | null {
  // 只展示最近几条工具调用，完整历史仍保存在 session 中。
  const visible = toolCalls.slice(-6);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiColors.border} paddingX={1} marginBottom={1}>
      <Text bold>Tool Calls <Text color={tuiColors.textDim}>{expanded ? "Ctrl-O/Ctrl-D collapse" : "Ctrl-O/Ctrl-D details"}</Text></Text>
      {visible.map((call) => (
        <Box key={call.id} flexDirection="column">
          <Text>
            <Text color={statusColor(call.status)}>{statusSymbol(call.status)} {toolIcon(call.tool)} </Text>
            <Text color={tuiColors.accent} bold>{toolAction(call.tool)}</Text>
            {call.argsSummary ? <Text> {call.argsSummary}</Text> : null}
          </Text>
          {expanded ? <Text color={tuiColors.textDim}>  {formatMeta(call)}</Text> : null}
          {expanded && call.resultSummary ? <ToolResultSummary summary={call.resultSummary} /> : null}
        </Box>
      ))}
    </Box>
  );
}

function ToolResultSummary({ summary }: { summary: string }): React.ReactElement {
  const lines = isBlockSummary(summary)
    ? summary.split("\n")
    : [`  result: ${summary}`];
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <MarkdownText key={`tool-result-${String(index)}`} line={line} muted />
      ))}
    </Box>
  );
}

function isBlockSummary(summary: string): boolean {
  return /^(Created|Edited|Deleted|Read|Write) /.test(summary) || /^(?:\+\d+\s+)?-\d+\s+\S/.test(summary) || /^\+\d+\s+\S/.test(summary);
}

function statusColor(status: TuiToolCall["status"]): string {
  // 颜色与状态一一对应，避免在 JSX 中重复三元表达式。
  if (status === "success") return tuiColors.success;
  if (status === "failed") return tuiColors.error;
  if (status === "denied") return tuiColors.error;
  if (status === "skipped") return tuiColors.textDim;
  if (status === "pending") return tuiColors.textDim;
  return tuiColors.warning;
}

function statusSymbol(status: TuiToolCall["status"]): string {
  // 符号用于窄终端快速识别工具调用状态。
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "denied") return "⊘";
  if (status === "skipped") return "↷";
  if (status === "pending") return "…";
  return "…";
}

function toolIcon(tool: string): string {
  if (tool === "search_files" || tool === "grep_search") return "🔍";
  if (tool === "read_file" || tool === "list_files" || tool === "git_status") return "📖";
  if (tool === "write_file" || tool === "edit_file") return "✏️";
  if (tool === "run_command") return "💻";
  return "•";
}

function toolAction(tool: string): string {
  if (tool === "run_command") return "Ran";
  if (tool === "read_file") return "Read";
  if (tool === "write_file") return "Wrote";
  if (tool === "edit_file") return "Edited";
  if (tool === "list_files") return "Listed";
  if (tool === "search_files" || tool === "grep_search") return "Searched";
  if (tool === "git_status") return "Checked";
  if (tool === "git_diff") return "Viewed";
  return tool;
}

function formatMeta(call: TuiToolCall): string {
  const parts = [
    call.durationMs === undefined ? undefined : `${String(call.durationMs)}ms`,
    call.outputLines === undefined ? undefined : `${String(call.outputLines)} output lines`,
    call.exitCode === undefined ? undefined : `exit ${String(call.exitCode)}`,
    call.truncated ? "truncated" : undefined,
    `status ${call.status}`
  ].filter(Boolean);
  return parts.join(" · ");
}
