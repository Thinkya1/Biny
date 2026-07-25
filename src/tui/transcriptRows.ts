/**
 * Width-aware transcript row layout.
 *
 * Every item is converted to terminal rows before viewport slicing. Tool
 * output is wrapped at the available cell width before the default four-row
 * limit. Completed thinking defaults to a collapsed header.
 */
import {
  clampTerminalLines,
  stripAnsi,
  terminalWidth,
  truncateToTerminalWidth,
  wrapTerminalLines
} from "./terminalText.js";
import type {
  ReasoningTranscriptItem,
  ToolTranscriptItem,
  ToolTranscriptStatus,
  TranscriptItem,
  TranscriptState
} from "./types.js";

export type TranscriptDisplayRow =
  | {
    kind: "message";
    id: string;
    itemKind: "user" | "reasoning" | "assistant" | "notification" | "error";
    prefix: string;
    text: string;
    tone?: "muted" | "success" | "warning";
  }
  | {
    kind: "block-header";
    id: string;
    block: "thinking" | "tool";
    itemId: string;
    collapsed: boolean;
    status?: ToolTranscriptStatus;
    marker: string;
    title: string;
    gap: string;
    duration: string;
  }
  | { kind: "tool-title"; id: string; status: ToolTranscriptStatus; marker: string; title: string; gap: string; duration: string }
  | { kind: "tool-output"; id: string; status: ToolTranscriptStatus; prefix: string; text: string; omitted: boolean }
  | { kind: "spacer"; id: string };

export interface TranscriptViewportOptions {
  width: number;
  height: number;
  scrollOffset: number;
  followLatest: boolean;
  /** @deprecated Prefer expandedIds */
  expandedToolId?: string;
  /** Item ids that should render expanded body (tools + thinking). */
  expandedIds?: ReadonlySet<string>;
}

const defaultToolOutputRows = 4;

export function transcriptRowsForDisplay(
  transcript: TranscriptState,
  width: number,
  expandedToolId?: string,
  expandedIds?: ReadonlySet<string>
): TranscriptDisplayRow[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const items: TranscriptItem[] = [...transcript.committed, ...transcript.active];
  const expanded = expandedIds ?? (expandedToolId ? new Set([expandedToolId]) : undefined);
  return items.flatMap((item) => rowsForItem(item, safeWidth, isExpanded(item, expanded)));
}

export function visibleTranscriptRows(
  transcript: TranscriptState,
  options: TranscriptViewportOptions
): TranscriptDisplayRow[] {
  const rows = transcriptRowsForDisplay(
    transcript,
    options.width,
    options.expandedToolId,
    options.expandedIds
  );
  return sliceTranscriptRows(rows, options);
}

/** Slice a precomputed row list into the current viewport (cheap; no re-wrap). */
export function sliceTranscriptRows(
  rows: readonly TranscriptDisplayRow[],
  options: Pick<TranscriptViewportOptions, "height" | "scrollOffset" | "followLatest">
): TranscriptDisplayRow[] {
  const height = Math.max(0, Math.floor(options.height));
  if (height === 0) return [];
  const bottomStart = Math.max(0, rows.length - height);
  const start = options.followLatest
    ? bottomStart
    : Math.max(0, bottomStart - Math.max(0, Math.floor(options.scrollOffset)));
  return rows.slice(start, start + height);
}

export function transcriptScrollMaxOffset(totalRows: number, height: number): number {
  return Math.max(0, Math.floor(totalRows) - Math.max(0, Math.floor(height)));
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

export function thinkingHeaderLabel(item: ReasoningTranscriptItem, running: boolean): string {
  if (running) {
    const live = item.startedAtMs === undefined
      ? undefined
      : Math.max(0, Date.now() - item.startedAtMs);
    const duration = formatToolDuration(live);
    return duration ? `Thinking… ${duration}` : "Thinking…";
  }
  const duration = formatToolDuration(item.durationMs);
  return duration ? `Thought for ${duration}` : "Thought";
}

export function foldableTranscriptItems(transcript: TranscriptState): TranscriptItem[] {
  return [...transcript.committed, ...transcript.active].filter((item) =>
    item.kind === "tool" || item.kind === "reasoning"
  );
}

function isExpanded(item: TranscriptItem, expanded: ReadonlySet<string> | undefined): boolean {
  if (!expanded) return false;
  return expanded.has(item.id);
}

function rowsForItem(item: TranscriptItem, width: number, expanded: boolean): TranscriptDisplayRow[] {
  if (item.kind === "tool") return toolRows(item, width, expanded);
  if (item.kind === "reasoning") return reasoningRows(item, width, expanded);
  if (item.kind === "user") return userRows(item, width);
  if (item.kind === "assistant") return assistantRows(item, width);

  const prefix = item.kind === "notification" ? "• " : item.kind === "error" ? "Error " : "";
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

function userRows(item: Extract<TranscriptItem, { kind: "user" }>, width: number): TranscriptDisplayRow[] {
  const prefix = "❯ ";
  const visiblePrefix = terminalWidth(prefix) < width ? prefix : "";
  const contentWidth = Math.max(1, width - terminalWidth(visiblePrefix));
  const lines = wrapTerminalLines(normalizeOutput(item.content), contentWidth);
  const rows: TranscriptDisplayRow[] = lines.map((line, index) => ({
    kind: "message",
    id: `${item.id}-${String(index)}`,
    itemKind: "user",
    prefix: index === 0 ? visiblePrefix : " ".repeat(terminalWidth(visiblePrefix)),
    text: line
  }));
  rows.push({ kind: "spacer", id: `${item.id}-spacer` });
  return rows;
}

function assistantRows(item: Extract<TranscriptItem, { kind: "assistant" }>, width: number): TranscriptDisplayRow[] {
  const lines = wrapTerminalLines(normalizeOutput(item.content), width);
  const rows: TranscriptDisplayRow[] = lines.map((line, index) => ({
    kind: "message",
    id: `${item.id}-${String(index)}`,
    itemKind: "assistant",
    prefix: "",
    text: line
  }));
  rows.push({ kind: "spacer", id: `${item.id}-spacer` });
  return rows;
}

function reasoningRows(item: ReasoningTranscriptItem, width: number, expanded: boolean): TranscriptDisplayRow[] {
  const running = item.startedAtMs !== undefined && item.durationMs === undefined;
  // Completed thinking collapses by default; streaming stays open.
  const collapsed = !running && !expanded;
  const title = thinkingHeaderLabel(item, running);
  const header = blockHeaderRow({
    id: `${item.id}-header`,
    itemId: item.id,
    block: "thinking",
    collapsed,
    marker: collapsed ? "▸ " : "▾ ",
    title,
    duration: "",
    width
  });
  if (collapsed) {
    return [header, { kind: "spacer", id: `${item.id}-spacer` }];
  }

  const bodyPrefix = width >= 2 ? "  " : "";
  const bodyWidth = Math.max(1, width - terminalWidth(bodyPrefix));
  const lines = wrapTerminalLines(normalizeOutput(item.content), bodyWidth);
  const rows: TranscriptDisplayRow[] = [header];
  lines.forEach((line, index) => {
    rows.push({
      kind: "message",
      id: `${item.id}-body-${String(index)}`,
      itemKind: "reasoning",
      prefix: bodyPrefix,
      text: line
    });
  });
  rows.push({ kind: "spacer", id: `${item.id}-spacer` });
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

function blockHeaderRow(options: {
  id: string;
  itemId: string;
  block: "thinking" | "tool";
  collapsed: boolean;
  marker: string;
  title: string;
  duration: string;
  width: number;
  status?: ToolTranscriptStatus;
}): Extract<TranscriptDisplayRow, { kind: "block-header" }> {
  const markerWidth = terminalWidth(options.marker);
  const durationWidth = terminalWidth(options.duration);
  const minimumGap = options.duration ? 1 : 0;
  const titleWidth = Math.max(0, options.width - markerWidth - durationWidth - minimumGap);
  const title = truncateToTerminalWidth(options.title, titleWidth);
  const used = markerWidth + terminalWidth(title) + durationWidth;
  const gap = options.duration ? " ".repeat(Math.max(1, options.width - used)) : "";
  return {
    kind: "block-header",
    id: options.id,
    block: options.block,
    itemId: options.itemId,
    collapsed: options.collapsed,
    status: options.status,
    marker: truncateToTerminalWidth(options.marker, options.width, ""),
    title,
    gap: used < options.width ? gap : "",
    duration: used <= options.width ? options.duration : ""
  };
}

function toolTitleRow(item: ToolTranscriptItem, width: number): Extract<TranscriptDisplayRow, { kind: "tool-title" }> {
  const marker = toolStatusMarker(item.status);
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

function toolStatusMarker(status: ToolTranscriptStatus): string {
  if (status === "success") return "✓ ";
  if (status === "failed" || status === "denied") return "✗ ";
  if (status === "running") return "● ";
  if (status === "pending") return "○ ";
  if (status === "skipped") return "– ";
  return "• ";
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
