/**
 * 工具 diff 摘要投影模块。
 *
 * 把 write/edit 的 diffPreview 或 git_diff 的 output 转成适合 TUI 展示的文件级摘要，避免直接展示
 * 原始 JSON result。
 */
import { formatDiffPreviewLines, renderDiffLineSetClustered, renderFileContentPreview, type DiffLine } from "./diffPreview.js";

export type ToolDiffOperation = "Created" | "Edited" | "Deleted";

export interface ToolDiffFileSummary {
  path: string;
  operation: ToolDiffOperation;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const maxRenderedDiffLines = 160;

export function formatToolDiffSummary(tool: string, result: unknown): string | undefined {
  const contentPreview = extractContentPreview(tool, result);
  if (contentPreview) return contentPreview;

  const diff = extractDiffText(tool, result);
  if (!diff) return undefined;

  const fallbackPath = extractStringField(result, "path");
  const files = parseDiffFiles(diff, fallbackPath);
  if (!files.length) return undefined;

  const rendered: string[] = [];
  let remaining = maxRenderedDiffLines;
  for (const file of files) {
    if (rendered.length > 0) rendered.push("");
    const preview = renderDiffLineSetClustered(file.lines, file.path, { contextLines: 3, maxLines: remaining });
    const formatted = formatDiffPreviewLines(preview).split("\n");
    for (const line of formatted) {
      rendered.push(line);
    }
    remaining -= Math.max(0, formatted.length - 1);
    if (remaining <= 0) {
      rendered.push("     … diff truncated");
      return rendered.join("\n");
    }
  }

  return rendered.join("\n");
}

export function formatToolResultSummary(tool: string, result: unknown): string | undefined {
  return formatToolDiffSummary(tool, result) ?? formatReadFileSummary(tool, result);
}

function extractDiffText(tool: string, result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const diffPreview = typeof record.diffPreview === "string" ? record.diffPreview : undefined;
  if (diffPreview && hasVisibleDiff(diffPreview)) return diffPreview;

  const output = typeof record.output === "string" ? record.output : undefined;
  if (tool === "git_diff" && output && hasVisibleDiff(output)) return output;
  return undefined;
}

function extractContentPreview(tool: string, result: unknown): string | undefined {
  if (tool !== "write_file" || typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const content = typeof record.contentPreview === "string" ? record.contentPreview : undefined;
  const path = typeof record.path === "string" ? record.path : "file";
  if (content === undefined) return undefined;
  return formatDiffPreviewLines(renderFileContentPreview(path, content, { maxLines: 12 }));
}

function hasVisibleDiff(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.startsWith("(no changes");
}

function parseDiffFiles(diff: string, fallbackPath: string | undefined): ToolDiffFileSummary[] {
  const files: ToolDiffFileSummary[] = [];
  let current: MutableDiffFile | undefined;

  for (const line of diff.split("\n")) {
    const gitPath = parseGitDiffPath(line);
    if (gitPath) {
      pushCurrent(files, current, fallbackPath);
      current = createMutableFile(gitPath);
      continue;
    }

    if (line.startsWith("--- ")) {
      if (!current) current = createMutableFile(normalizeDiffPath(line.slice(4)) ?? fallbackPath ?? "changes");
      current.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!current) current = createMutableFile(normalizeDiffPath(line.slice(4)) ?? fallbackPath ?? "changes");
      current.newPath = normalizeDiffPath(line.slice(4));
      current.path = current.newPath ?? current.oldPath ?? current.path;
      continue;
    }

    if (!current) current = createMutableFile(fallbackPath ?? "changes");
    const parsed = parseDiffLine(line, current);
    if (!parsed) continue;
    current.lines.push(parsed);
    if (parsed.kind === "add") current.additions += 1;
    if (parsed.kind === "delete") current.deletions += 1;
  }

  pushCurrent(files, current, fallbackPath);
  return files.filter((file) => file.additions > 0 || file.deletions > 0);
}

interface MutableDiffFile extends ToolDiffFileSummary {
  oldPath?: string;
  newPath?: string;
  oldLine: number;
  newLine: number;
}

function createMutableFile(filePath: string): MutableDiffFile {
  return { path: filePath, operation: "Edited", additions: 0, deletions: 0, lines: [], oldLine: 1, newLine: 1 };
}

function pushCurrent(files: ToolDiffFileSummary[], current: MutableDiffFile | undefined, fallbackPath: string | undefined): void {
  if (!current) return;
  const operation = diffOperation(current);
  files.push({
    path: diffDisplayPath(current, operation, fallbackPath),
    operation,
    additions: current.additions,
    deletions: current.deletions,
    lines: current.lines
  });
}

function parseGitDiffPath(line: string): string | undefined {
  const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
  return match?.[2] ? normalizeDiffPath(match[2]) : undefined;
}

function parseDiffLine(line: string, file: MutableDiffFile): DiffLine | undefined {
  if (line.startsWith("@@")) {
    const range = parseHunkRange(line);
    file.oldLine = range.oldStart;
    file.newLine = range.newStart;
    return undefined;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    const parsed = { kind: "add" as const, lineNum: file.newLine, content: line.slice(1) };
    file.newLine += 1;
    return parsed;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    const parsed = { kind: "delete" as const, lineNum: file.oldLine, content: line.slice(1) };
    file.oldLine += 1;
    return parsed;
  }
  if (line.startsWith(" ")) {
    const parsed = { kind: "context" as const, lineNum: file.newLine, content: line.slice(1) };
    file.oldLine += 1;
    file.newLine += 1;
    return parsed;
  }
  return undefined;
}

function parseHunkRange(line: string): { oldStart: number; newStart: number } {
  const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  return {
    oldStart: match?.[1] ? Number.parseInt(match[1], 10) : 1,
    newStart: match?.[2] ? Number.parseInt(match[2], 10) : 1
  };
}

function diffOperation(file: MutableDiffFile): ToolDiffOperation {
  if (!file.oldPath && file.newPath) return "Created";
  if (file.oldPath && !file.newPath) return "Deleted";
  return "Edited";
}

function diffDisplayPath(file: MutableDiffFile, operation: ToolDiffOperation, fallbackPath: string | undefined): string {
  if (operation === "Deleted") return file.oldPath ?? file.path ?? fallbackPath ?? "changes";
  return file.newPath ?? file.oldPath ?? file.path ?? fallbackPath ?? "changes";
}

function formatReadFileSummary(tool: string, result: unknown): string | undefined {
  if (tool !== "read_file" || typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : undefined;
  if (content === undefined) return undefined;
  const path = typeof record.path === "string" ? record.path : "file";
  return `Read ${path}\n${content.slice(0, 4000)}`;
}

function normalizeDiffPath(value: string): string | undefined {
  const token = value.trim().split(/\s+/)[0] ?? "";
  if (!token || token === "/dev/null") return undefined;
  if (token.startsWith("a/") || token.startsWith("b/")) return token.slice(2);
  return token;
}

function extractStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
