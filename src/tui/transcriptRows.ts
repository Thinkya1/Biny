/**
 * Width-aware transcript row layout.
 *
 * Every item is converted to terminal rows before viewport slicing. Tool
 * output is therefore wrapped at the available cell width before the default
 * four-row limit is applied.
 */
import {
  clampTerminalLines,
  stripAnsi,
  terminalWidth,
  truncateToTerminalWidth,
  wrapTerminalLines
} from "./terminalText.js";
import type { ToolTranscriptItem, ToolTranscriptStatus, TranscriptItem, TranscriptState } from "./types.js";

export type TranscriptDisplayRow =
  | { kind: "message"; id: string; itemKind: "user" | "reasoning" | "assistant" | "notification" | "error"; prefix: string; text: string; tone?: "muted" | "success" | "warning" }
  | { kind: "tool-title"; id: string; status: ToolTranscriptStatus; marker: string; title: string; gap: string; duration: string }
  | { kind: "tool-output"; id: string; status: ToolTranscriptStatus; prefix: string; text: string; omitted: boolean }
  | { kind: "spacer"; id: string };

export interface TranscriptViewportOptions {
  width: number;
  height: number;
  scrollOffset: number;
  followLatest: boolean;
  expandedToolId?: string;
}

const defaultToolOutputRows = 4;

export function transcriptRowsForDisplay(
  transcript: TranscriptState,
  width: number,
  expandedToolId?: string
): TranscriptDisplayRow[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const items: TranscriptItem[] = [...transcript.committed, ...transcript.active];
  return items.flatMap((item) => rowsForItem(item, safeWidth, item.kind === "tool" && item.id === expandedToolId));
}

export function visibleTranscriptRows(
  transcript: TranscriptState,
  options: TranscriptViewportOptions
): TranscriptDisplayRow[] {
  const rows = transcriptRowsForDisplay(transcript, options.width, options.expandedToolId);
  const height = Math.max(0, Math.floor(options.height));
  if (height === 0) return [];
  const bottomStart = Math.max(0, rows.length - height);
  const start = options.followLatest
    ? bottomStart
    : Math.max(0, bottomStart - Math.max(0, Math.floor(options.scrollOffset)));
  return rows.slice(start, start + height);
}

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `${String(Math.max(0, Math.round(durationMs)))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainder)}s`;
}

function rowsForItem(item: TranscriptItem, width: number, expanded: boolean): TranscriptDisplayRow[] {
  if (item.kind === "tool") return toolRows(item, width, expanded);
  const prefix = item.kind === "user" ? "› " : item.kind === "reasoning" ? "∴ " : item.kind === "notification" ? "• " : item.kind === "error" ? "Error " : "";
  const visiblePrefix = terminalWidth(prefix) < width ? prefix : "";
  const contentWidth = Math.max(1, width - terminalWidth(visiblePrefix));
  const lines = wrapTerminalLines(normalizeOutput(item.content), contentWidth);
  const rows: TranscriptDisplayRow[] = lines.map((line, index) => ({
    kind: "message",
    id: `${item.id}-${String(index)}`,
    itemKind: item.kind,
    prefix: index === 0 ? visiblePrefix : " ".repeat(terminalWidth(visiblePrefix)),
    text: line,
    tone: item.kind === "notification" ? item.tone : undefined
  }));
  if (item.kind !== "notification") rows.push({ kind: "spacer", id: `${item.id}-spacer` });
  return rows;
}

function toolRows(item: ToolTranscriptItem, width: number, expanded: boolean): TranscriptDisplayRow[] {
  const rows: TranscriptDisplayRow[] = [toolTitleRow(item, width)];
  const source = normalizeOutput(expanded
    ? item.details ?? item.output ?? emptyToolOutput(item)
    : item.output ?? item.progress ?? emptyToolOutput(item));
  const firstPrefix = width >= 2 ? "└ " : "";
  const nextPrefix = " ".repeat(terminalWidth(firstPrefix));
  const bodyWidth = Math.max(1, width - terminalWidth(firstPrefix));

  if (expanded) {
    const lines = wrapTerminalLines(source, bodyWidth);
    lines.forEach((line, index) => rows.push({
      kind: "tool-output",
      id: `${item.id}-detail-${String(index)}`,
      status: item.status,
      prefix: index === 0 ? firstPrefix : nextPrefix,
      text: line,
      omitted: false
    }));
  } else {
    const clamped = clampToolOutput(source, bodyWidth, item.status === "running");
    clamped.lines.forEach((line, index) => rows.push({
      kind: "tool-output",
      id: `${item.id}-output-${String(index)}`,
      status: item.status,
      prefix: index === 0 ? firstPrefix : nextPrefix,
      text: line,
      omitted: false
    }));
    if (clamped.hiddenLines > 0) {
      const direction = item.status === "running" ? "earlier" : "more";
      const omitted = `… ${String(clamped.hiddenLines)} ${direction} visual line${clamped.hiddenLines === 1 ? "" : "s"}`;
      rows.push({
        kind: "tool-output",
        id: `${item.id}-omitted`,
        status: item.status,
        prefix: nextPrefix,
        text: truncateToTerminalWidth(omitted, bodyWidth),
        omitted: true
      });
    }
  }
  rows.push({ kind: "spacer", id: `${item.id}-spacer` });
  return rows;
}

function toolTitleRow(item: ToolTranscriptItem, width: number): Extract<TranscriptDisplayRow, { kind: "tool-title" }> {
  const marker = "• ";
  const runningDuration = item.status === "running" && item.startedAtMs !== undefined
    ? Math.max(0, Date.now() - item.startedAtMs)
    : undefined;
  const duration = formatToolDuration(item.durationMs ?? runningDuration);
  const markerWidth = terminalWidth(marker);
  const durationWidth = terminalWidth(duration);
  const minimumGap = duration ? 1 : 0;
  const titleWidth = Math.max(0, width - markerWidth - durationWidth - minimumGap);
  const title = truncateToTerminalWidth(item.title, titleWidth);
  const used = markerWidth + terminalWidth(title) + durationWidth;
  const gap = duration ? " ".repeat(Math.max(1, width - used)) : "";
  return {
    kind: "tool-title",
    id: `${item.id}-title`,
    status: item.status,
    marker: truncateToTerminalWidth(marker, width, ""),
    title,
    gap: used < width ? gap : "",
    duration: used <= width ? duration : ""
  };
}

function emptyToolOutput(item: ToolTranscriptItem): string {
  if (item.status === "running" || item.status === "pending") return "Working…";
  if (item.status === "success") return "Completed";
  if (item.status === "denied") return "Denied";
  if (item.status === "skipped") return "Skipped";
  return "Failed";
}

function clampToolOutput(text: string, width: number, fromEnd: boolean): { lines: string[]; hiddenLines: number } {
  if (!fromEnd) return clampTerminalLines(text, width, defaultToolOutputRows);
  const wrapped = wrapTerminalLines(text, width);
  return {
    lines: wrapped.slice(-defaultToolOutputRows),
    hiddenLines: Math.max(0, wrapped.length - defaultToolOutputRows)
  };
}

function normalizeOutput(value: string): string {
  return stripAnsi(value).replaceAll("\t", "    ");
}
