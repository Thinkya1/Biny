/**
 * TUI diff 行样式辅助。
 *
 * 只给真正的代码增删行上色，跳过 git diff 文件头 `+++` / `---`，避免头信息被误当成代码。
 */
import { tuiColors } from "./theme/index.js";

export type DiffLineColor = string | undefined;

export interface DiffLineStyle {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export type DiffHeaderOperation = "Created" | "Edited" | "Deleted";

export interface DiffHeader {
  operation: DiffHeaderOperation;
  path: string;
  additions: number | undefined;
  deletions: number | undefined;
}

export interface DiffCodeLine {
  oldColumn: string;
  newColumn: string;
  prefix: "+" | "-" | " ";
  content: string;
}

export interface KimiDiffCodeLine {
  lineColumn: string;
  prefix: "+" | "-" | " ";
  content: string;
}

export function diffLineColor(line: string): DiffLineColor {
  if (line.startsWith("+++") || line.startsWith("---")) return undefined;
  if (line.startsWith("+")) return tuiColors.success;
  if (line.startsWith("-")) return tuiColors.error;
  return undefined;
}

export function diffLineStyle(line: string): DiffLineStyle | undefined {
  const trimmed = line.trimStart();
  const rawSemantic = line.startsWith("  ") ? line.slice(2) : line;

  if (parseKimiDiffHeader(line)) return { color: tuiColors.primary, bold: true };
  if (parseDiffHeader(line)) return { color: tuiColors.primary, bold: true };
  if (trimmed.startsWith("diff --git") || trimmed.startsWith("index ") || trimmed.startsWith("new file mode") || trimmed.startsWith("deleted file mode")) {
    return { color: tuiColors.diffMeta, dimColor: true };
  }
  if (trimmed.startsWith("+++") || trimmed.startsWith("---") || trimmed.startsWith("@@")) return { color: tuiColors.diffMeta, dimColor: true };
  const kimiLine = parseKimiDiffCodeLine(line);
  if (kimiLine?.prefix === "+") return { color: tuiColors.success };
  if (kimiLine?.prefix === "-") return { color: tuiColors.error };
  if (kimiLine?.prefix === " ") return { color: tuiColors.diffMeta, dimColor: true };
  const codeLine = parseDiffCodeLine(line);
  if (codeLine?.prefix === "+") return { color: tuiColors.success };
  if (codeLine?.prefix === "-") return { color: tuiColors.error };
  if (codeLine?.prefix === " ") return { color: tuiColors.diffMeta, dimColor: true };
  if (rawSemantic.startsWith("+")) return { color: tuiColors.success };
  if (rawSemantic.startsWith("-")) return { color: tuiColors.error };
  if (rawSemantic.startsWith(" ")) return { color: tuiColors.diffMeta, dimColor: true };
  return undefined;
}

export function parseDiffHeader(line: string): DiffHeader | undefined {
  const trimmed = line.trim();
  const created = trimmed.match(/^Created (.+) \(\+(\d+)\)$/);
  if (created?.[1] && created[2]) {
    return { operation: "Created", path: created[1], additions: Number.parseInt(created[2], 10), deletions: undefined };
  }

  const edited = trimmed.match(/^Edited (.+) \(\+(\d+) -(\d+)\)$/);
  if (edited?.[1] && edited[2] && edited[3]) {
    return { operation: "Edited", path: edited[1], additions: Number.parseInt(edited[2], 10), deletions: Number.parseInt(edited[3], 10) };
  }

  const deleted = trimmed.match(/^Deleted (.+) \(-(\d+)\)$/);
  if (deleted?.[1] && deleted[2]) {
    return { operation: "Deleted", path: deleted[1], additions: undefined, deletions: Number.parseInt(deleted[2], 10) };
  }

  return undefined;
}

export function parseKimiDiffHeader(line: string): { path: string; additions: number | undefined; deletions: number | undefined } | undefined {
  const trimmed = line.trim();
  const match = trimmed.match(/^(?:(\+\d+)\s+)?(?:(-\d+)\s+)?(.+)$/);
  if (!match?.[3]) return undefined;
  if (!match[1] && !match[2]) return undefined;
  const additions = match[1] ? Number.parseInt(match[1].slice(1), 10) : undefined;
  const deletions = match[2] ? Number.parseInt(match[2].slice(1), 10) : undefined;
  return { path: match[3], additions, deletions };
}

export function parseDiffCodeLine(line: string): DiffCodeLine | undefined {
  return parseDiffCodeLineExact(line) ?? (line.startsWith("  ") ? parseDiffCodeLineExact(line.slice(2)) : undefined);
}

export function parseKimiDiffCodeLine(line: string): KimiDiffCodeLine | undefined {
  return parseKimiDiffCodeLineExact(line) ?? (line.startsWith("  ") ? parseKimiDiffCodeLineExact(line.slice(2)) : undefined);
}

export function padDiffLine(line: string, _width: number): string {
  // Kept as a compatibility helper; foreground-only diff rows need no padding.
  return line;
}

function parseDiffCodeLineExact(line: string): DiffCodeLine | undefined {
  const match = line.match(/^(.{4}) (.{4}) ([+\- ]) (.*)$/);
  if (!match?.[1] || !match[2] || !match[3] || match[4] === undefined) return undefined;
  const oldColumn = match[1];
  const newColumn = match[2];
  if (!/^[\d ]{4}$/.test(oldColumn) || !/^[\d ]{4}$/.test(newColumn)) return undefined;
  if (!/\d/.test(oldColumn) && !/\d/.test(newColumn)) return undefined;
  const prefix = match[3] as "+" | "-" | " ";
  return { oldColumn, newColumn, prefix, content: match[4] };
}

function parseKimiDiffCodeLineExact(line: string): KimiDiffCodeLine | undefined {
  const match = line.match(/^(\s*\d+)\s([+\- ])\s(.*)$/);
  if (!match?.[1] || !match[2] || match[3] === undefined) return undefined;
  const prefix = match[2] as "+" | "-" | " ";
  return { lineColumn: match[1], prefix, content: match[3] };
}
