import type { ToolInputDisplay } from "../tools/types.js";
import { formatToolResultSummary } from "./toolDiffSummary.js";

export interface ToolOutputSummary {
  summary: string;
  fullTitle?: string;
  fullContent?: string;
}

const commandHeadLines = 8;
const diffHeadLines = 8;
const diffTailLines = 4;

export function summarizeToolOutput(
  tool: string,
  result: unknown,
  argsSummary: string,
  display: ToolInputDisplay | undefined
): ToolOutputSummary {
  if (tool === "run_command") {
    return summarizeRunCommand(result, argsSummary, display);
  }
  if (tool === "git_diff") {
    return summarizeGitDiff(result);
  }
  return { summary: formatToolResultSummary(tool, result) ?? summarizeValue(result) };
}

function summarizeRunCommand(result: unknown, argsSummary: string, display: ToolInputDisplay | undefined): ToolOutputSummary {
  const command = display?.kind === "command" ? display.command : argsSummary || "command";
  const full = commandResultText(result);
  const title = `Ran ${command}`;
  const collapsed = collapseHead(full, commandHeadLines);
  if (!collapsed.truncated) return { summary: `${title}\n${full}`.trimEnd() };
  return {
    summary: `${title}\n${collapsed.text}\n${hiddenLine(collapsed.hidden)}`,
    fullTitle: title,
    fullContent: full
  };
}

function summarizeGitDiff(result: unknown): ToolOutputSummary {
  const full = extractOutput(result) ?? (formatToolResultSummary("git_diff", result) ?? summarizeValue(result));
  const title = "Ran git diff";
  const collapsed = collapseHeadTail(full, diffHeadLines, diffTailLines);
  if (!collapsed.truncated) {
    const formatted = formatToolResultSummary("git_diff", result);
    return { summary: formatted ?? `${title}\n${full}`.trimEnd() };
  }
  return {
    summary: `${title}\n${collapsed.text}\n${hiddenLine(collapsed.hidden)}`,
    fullTitle: title,
    fullContent: full
  };
}

function commandResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return summarizeValue(result);
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
  const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
  const parts = [stdout, stderr].filter((part) => part.length > 0);
  if (parts.length > 0) return parts.join("\n");
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  return exitCode === undefined ? "" : `exit ${String(exitCode)}`;
}

function extractOutput(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const output = (result as Record<string, unknown>).output;
  return typeof output === "string" ? output.trimEnd() : undefined;
}

function collapseHead(value: string, headLines: number): { text: string; hidden: number; truncated: boolean } {
  const lines = splitLines(value);
  if (lines.length <= headLines) return { text: value, hidden: 0, truncated: false };
  return {
    text: lines.slice(0, headLines).join("\n"),
    hidden: lines.length - headLines,
    truncated: true
  };
}

function collapseHeadTail(value: string, headLines: number, tailLines: number): { text: string; hidden: number; truncated: boolean } {
  const lines = splitLines(value);
  if (lines.length <= headLines + tailLines) return { text: value, hidden: 0, truncated: false };
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  return {
    text: [...head, ...tail].join("\n"),
    hidden: lines.length - head.length - tail.length,
    truncated: true
  };
}

function hiddenLine(hidden: number): string {
  return `… ${String(hidden)} lines (ctrl + t to view transcript)`;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  return value.split("\n");
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}
