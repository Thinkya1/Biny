import type { ColorToken } from "./theme/index.js";

export type DiffLineKind = "context" | "add" | "delete";

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  content: string;
}

export type DiffPreviewLine =
  | { kind: "header"; content: string; path: string; additions: number; deletions: number; style: DiffPreviewLineStyle }
  | { kind: DiffLineKind; content: string; lineNum: number; marker: "+" | "-" | " "; style: DiffPreviewLineStyle }
  | { kind: "content"; content: string; lineNum: number; style: DiffPreviewLineStyle }
  | { kind: "meta"; content: string; style: DiffPreviewLineStyle };

export interface DiffPreviewLineStyle {
  additions?: ColorToken;
  deletions?: ColorToken;
  path?: ColorToken;
  gutter?: ColorToken;
  marker?: ColorToken;
  content?: ColorToken;
  bold?: boolean;
  dimColor?: boolean;
}

export const diffPreviewStyles = {
  header: { bold: true, additions: "diffAddedStrong", deletions: "diffRemovedStrong", path: "textStrong" },
  add: { gutter: "diffGutter", marker: "diffAdded", content: "diffAdded" },
  delete: { gutter: "diffGutter", marker: "diffRemoved", content: "diffRemoved" },
  context: { gutter: "diffGutter", marker: "diffMeta", content: "textDim", dimColor: true },
  content: { gutter: "diffGutter", content: "text" },
  meta: { content: "diffMeta", dimColor: true }
} satisfies Record<"header" | DiffLineKind | "content" | "meta", DiffPreviewLineStyle>;

export interface ClusteredDiffOptions {
  contextLines?: number;
  maxLines?: number;
  isIncomplete?: boolean;
  expandKeyHint?: string;
}

export interface FileContentPreviewOptions {
  maxLines?: number;
}

interface Cluster {
  start: number;
  end: number;
}

export function computeDiffLines(
  oldText: string,
  newText: string,
  oldStart = 1,
  newStart = 1,
  isIncomplete = false
): DiffLine[] {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const dp: number[][] = Array.from({ length: oldLength + 1 }, () => Array.from({ length: newLength + 1 }, () => 0));

  for (let oldIndex = 1; oldIndex <= oldLength; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLength; newIndex += 1) {
      dp[oldIndex]![newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ? dp[oldIndex - 1]![newIndex - 1]! + 1
        : Math.max(dp[oldIndex - 1]![newIndex]!, dp[oldIndex]![newIndex - 1]!);
    }
  }

  const reversed: DiffLine[] = [];
  let oldIndex = oldLength;
  let newIndex = newLength;
  while (oldIndex > 0 || newIndex > 0) {
    if (oldIndex > 0 && newIndex > 0 && oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
      reversed.push({ kind: "context", lineNum: newStart + newIndex - 1, content: newLines[newIndex - 1]! });
      oldIndex -= 1;
      newIndex -= 1;
      continue;
    }
    if (newIndex > 0 && (oldIndex === 0 || dp[oldIndex]![newIndex - 1]! >= dp[oldIndex - 1]![newIndex]!)) {
      reversed.push({ kind: "add", lineNum: newStart + newIndex - 1, content: newLines[newIndex - 1]! });
      newIndex -= 1;
      continue;
    }
    reversed.push({ kind: "delete", lineNum: oldStart + oldIndex - 1, content: oldLines[oldIndex - 1]! });
    oldIndex -= 1;
  }

  const result = reversed.reverse();
  if (isIncomplete) suppressTrailingDeletes(result);
  return result;
}

export function renderDiffLines(
  oldText: string,
  newText: string,
  filePath: string,
  isIncomplete = false,
  oldStart?: number,
  newStart?: number,
  maxLines?: number
): DiffPreviewLine[] {
  const diffLines = computeDiffLines(oldText, newText, oldStart ?? 1, newStart ?? 1, isIncomplete);
  const changedLines = diffLines.filter((line) => line.kind !== "context");
  const additions = changedLines.filter((line) => line.kind === "add").length;
  const deletions = changedLines.filter((line) => line.kind === "delete").length;
  const shown = maxLines !== undefined && maxLines >= 0 && changedLines.length > maxLines
    ? changedLines.slice(0, maxLines)
    : changedLines;
  const rendered: DiffPreviewLine[] = [createHeader(filePath, additions, deletions)];
  rendered.push(...shown.map(diffLineToPreviewLine));
  const hidden = changedLines.length - shown.length;
  if (hidden > 0) rendered.push(createMeta(`     … ${String(hidden)} more change${hidden > 1 ? "s" : ""} hidden (ctrl+o to expand)`));
  return rendered;
}

export function renderDiffLinesClustered(
  oldText: string,
  newText: string,
  filePath: string,
  options: ClusteredDiffOptions = {}
): DiffPreviewLine[] {
  const contextLines = options.contextLines ?? 3;
  const diffLines = computeDiffLines(oldText, newText, 1, 1, options.isIncomplete ?? false);
  const { clusters, changedCount, additions, deletions } = buildClusters(diffLines, contextLines);
  const rendered: DiffPreviewLine[] = [createHeader(filePath, additions, deletions)];
  if (clusters.length === 0) return rendered;

  const maxLines = options.maxLines !== undefined && options.maxLines >= 0 ? options.maxLines : Number.POSITIVE_INFINITY;
  let bodyLines = 0;
  let previousEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (bodyLines >= maxLines) {
      truncated = true;
      break;
    }
    if (previousEnd >= 0) {
      const gap = cluster.start - previousEnd - 1;
      if (gap > 0) {
        if (bodyLines + 1 > maxLines) {
          truncated = true;
          break;
        }
        rendered.push(createMeta(`     … ${String(gap)} unchanged line${gap > 1 ? "s" : ""} …`));
        bodyLines += 1;
      }
    }
    for (let index = cluster.start; index <= cluster.end; index += 1) {
      if (bodyLines >= maxLines) {
        truncated = true;
        break outer;
      }
      const line = diffLines[index];
      if (!line) continue;
      rendered.push(diffLineToPreviewLine(line));
      bodyLines += 1;
      if (line.kind !== "context") shownChanges += 1;
      previousEnd = index;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = options.expandKeyHint ?? "ctrl+o";
      rendered.push(createMeta(`     … ${String(hidden)} more change${hidden > 1 ? "s" : ""} hidden (${hint} to expand)`));
    }
  }
  return rendered;
}

export function renderDiffLineSetClustered(
  diffLines: readonly DiffLine[],
  filePath: string,
  options: ClusteredDiffOptions = {}
): DiffPreviewLine[] {
  const contextLines = options.contextLines ?? 3;
  const { clusters, changedCount, additions, deletions } = buildClusters(diffLines, contextLines);
  const rendered: DiffPreviewLine[] = [createHeader(filePath, additions, deletions)];
  if (clusters.length === 0) return rendered;

  const maxLines = options.maxLines !== undefined && options.maxLines >= 0 ? options.maxLines : Number.POSITIVE_INFINITY;
  let bodyLines = 0;
  let previousEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (bodyLines >= maxLines) {
      truncated = true;
      break;
    }
    if (previousEnd >= 0) {
      const gap = cluster.start - previousEnd - 1;
      if (gap > 0) {
        if (bodyLines + 1 > maxLines) {
          truncated = true;
          break;
        }
        rendered.push(createMeta(`     … ${String(gap)} unchanged line${gap > 1 ? "s" : ""} …`));
        bodyLines += 1;
      }
    }
    for (let index = cluster.start; index <= cluster.end; index += 1) {
      if (bodyLines >= maxLines) {
        truncated = true;
        break outer;
      }
      const line = diffLines[index];
      if (!line) continue;
      rendered.push(diffLineToPreviewLine(line));
      bodyLines += 1;
      if (line.kind !== "context") shownChanges += 1;
      previousEnd = index;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = options.expandKeyHint ?? "ctrl+o";
      rendered.push(createMeta(`     … ${String(hidden)} more change${hidden > 1 ? "s" : ""} hidden (${hint} to expand)`));
    }
  }
  return rendered;
}

export function renderFileContentPreview(filePath: string, content: string, options: FileContentPreviewOptions = {}): DiffPreviewLine[] {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = normalized ? normalized.split("\n") : [];
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
  const shown = lines.slice(0, maxLines);
  const rendered: DiffPreviewLine[] = [createFileContentHeader(filePath, lines.length)];
  shown.forEach((line, index) => {
    rendered.push({ kind: "content", lineNum: index + 1, content: line, style: diffPreviewStyles.content });
  });
  const hidden = lines.length - shown.length;
  if (hidden > 0) rendered.push(createMeta(`     … ${String(hidden)} more line${hidden > 1 ? "s" : ""} hidden (ctrl+o to expand)`));
  return rendered;
}

export function formatDiffPreviewLines(lines: readonly DiffPreviewLine[]): string {
  return lines.map(formatDiffPreviewLine).join("\n");
}

export function formatDiffPreviewLine(line: DiffPreviewLine): string {
  if (line.kind === "header" || line.kind === "meta") return line.content;
  if (line.kind === "content") return `${String(line.lineNum).padStart(4, " ")}   ${line.content}`;
  return `${String(line.lineNum).padStart(4, " ")} ${line.marker} ${line.content}`;
}

function createHeader(filePath: string, additions: number, deletions: number): DiffPreviewLine {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${String(additions)}`);
  if (deletions > 0) parts.push(`-${String(deletions)}`);
  parts.push(filePath);
  return {
    kind: "header",
    content: parts.join(" "),
    path: filePath,
    additions,
    deletions,
    style: diffPreviewStyles.header
  };
}

function createFileContentHeader(filePath: string, additions: number): DiffPreviewLine {
  return {
    kind: "header",
    content: `Write ${filePath}`,
    path: filePath,
    additions,
    deletions: 0,
    style: diffPreviewStyles.header
  };
}

function diffLineToPreviewLine(line: DiffLine): DiffPreviewLine {
  if (line.kind === "add") {
    return { kind: "add", lineNum: line.lineNum, marker: "+", content: line.content, style: diffPreviewStyles.add };
  }
  if (line.kind === "delete") {
    return { kind: "delete", lineNum: line.lineNum, marker: "-", content: line.content, style: diffPreviewStyles.delete };
  }
  return { kind: "context", lineNum: line.lineNum, marker: " ", content: line.content, style: diffPreviewStyles.context };
}

function createMeta(content: string): DiffPreviewLine {
  return { kind: "meta", content, style: diffPreviewStyles.meta };
}

function buildClusters(diffLines: readonly DiffLine[], contextLines: number): { clusters: Cluster[]; changedCount: number; additions: number; deletions: number } {
  const changedIndexes: number[] = [];
  let additions = 0;
  let deletions = 0;
  diffLines.forEach((line, index) => {
    if (line.kind === "add") {
      additions += 1;
      changedIndexes.push(index);
    } else if (line.kind === "delete") {
      deletions += 1;
      changedIndexes.push(index);
    }
  });
  if (changedIndexes.length === 0) return { clusters: [], changedCount: 0, additions, deletions };

  const clusters: Cluster[] = [];
  const mergeGap = 2 * contextLines;
  let groupStart = changedIndexes[0]!;
  let groupEnd = changedIndexes[0]!;
  for (let index = 1; index < changedIndexes.length; index += 1) {
    const changedIndex = changedIndexes[index]!;
    if (changedIndex - groupEnd <= mergeGap) {
      groupEnd = changedIndex;
      continue;
    }
    clusters.push({ start: Math.max(0, groupStart - contextLines), end: Math.min(diffLines.length - 1, groupEnd + contextLines) });
    groupStart = changedIndex;
    groupEnd = changedIndex;
  }
  clusters.push({ start: Math.max(0, groupStart - contextLines), end: Math.min(diffLines.length - 1, groupEnd + contextLines) });
  return { clusters, changedCount: changedIndexes.length, additions, deletions };
}

function suppressTrailingDeletes(lines: DiffLine[]): void {
  let lastNonDelete = lines.length - 1;
  while (lastNonDelete >= 0 && lines[lastNonDelete]?.kind === "delete") {
    lastNonDelete -= 1;
  }
  if (lastNonDelete >= 0) {
    lines.length = lastNonDelete + 1;
  } else {
    lines.length = 0;
  }
}
