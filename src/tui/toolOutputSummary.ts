import type { ToolInputDisplay } from "../tools/types.js";
import { formatToolResultSummary } from "./toolDiffSummary.js";

export interface ToolOutputSummary {
  summary: string;
  fullTitle?: string;
  fullContent?: string;
}

const commandHeadLines = 8;
const commandPreviewLines = 4;
const readFilePreviewLines = 6;
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
  if (tool === "read_file") {
    return summarizeReadFile(result);
  }
  return { summary: formatToolResultSummary(tool, result) ?? summarizeValue(result) };
}

function summarizeRunCommand(result: unknown, argsSummary: string, display: ToolInputDisplay | undefined): ToolOutputSummary {
  const command = display?.kind === "command" ? display.command : argsSummary || "command";
  const parsed = commandResultParts(result);
  const title = `Ran ${command}`;
  const summary = [
    `  exit ${parsed.exitCode === undefined ? "unknown" : String(parsed.exitCode)}`,
    ...formatStreamPreview("stdout", parsed.stdout, commandPreviewLines),
    ...formatStreamPreview("stderr", parsed.stderr, commandPreviewLines)
  ].filter((line) => line.length > 0).join("\n");
  const full = commandFullText(parsed);
  const hidden = splitLines(parsed.stdout).slice(commandPreviewLines).length + splitLines(parsed.stderr).slice(commandPreviewLines).length;
  if (hidden === 0) return { summary, fullTitle: title };
  return {
    summary: `${summary}\n${hiddenLine(hidden)}`,
    fullTitle: title,
    fullContent: full
  };
}

function summarizeGitDiff(result: unknown): ToolOutputSummary {
  const full = extractOutput(result) ?? (formatToolResultSummary("git_diff", result) ?? summarizeValue(result));
  const title = "Viewed git diff";
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

function summarizeReadFile(result: unknown): ToolOutputSummary {
  if (typeof result !== "object" || result === null) return { summary: formatToolResultSummary("read_file", result) ?? summarizeValue(result) };
  const record = result as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content.trimEnd() : undefined;
  if (content === undefined) return { summary: formatToolResultSummary("read_file", result) ?? summarizeValue(result) };
  const path = typeof record.path === "string" ? record.path : "file";
  const title = `Read ${path}`;
  const collapsed = collapseHead(content, readFilePreviewLines);
  if (!collapsed.truncated) return { summary: `${title}\n${content}`.trimEnd() };
  return {
    summary: `${title}\n${collapsed.text}\n${hiddenLine(collapsed.hidden)}`,
    fullTitle: title,
    fullContent: content
  };
}

interface CommandResultParts {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

function commandResultParts(result: unknown): CommandResultParts {
  if (typeof result !== "object" || result === null) return { stdout: summarizeValue(result), stderr: "" };
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
  const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  return { stdout, stderr, exitCode };
}

function commandFullText(parts: CommandResultParts): string {
  return [
    `exit ${parts.exitCode === undefined ? "unknown" : String(parts.exitCode)}`,
    ...formatStreamFull("stdout", parts.stdout),
    ...formatStreamFull("stderr", parts.stderr)
  ].filter((line) => line.length > 0).join("\n");
}

function formatStreamPreview(label: "stdout" | "stderr", value: string, maxLines: number): string[] {
  const lines = splitLines(value);
  if (!lines.length) return [];
  return [`${label}:`, ...lines.slice(0, maxLines).map((line) => `  ${line}`)];
}

function formatStreamFull(label: "stdout" | "stderr", value: string): string[] {
  const lines = splitLines(value);
  if (!lines.length) return [];
  return [`${label}:`, ...lines.map((line) => `  ${line}`)];
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
