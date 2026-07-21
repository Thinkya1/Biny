/**
 * Tool transcript projection.
 *
 * Runtime tool events stay unchanged. This module converts their structured
 * input/result into a semantic transcript title, a full output body for
 * width-aware previewing, and folded details for raw command/result data.
 */
import type { ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { ToolTranscriptItem, ToolTranscriptStatus } from "./types.js";
import { formatToolResultSummary } from "./toolDiffSummary.js";

const activeOutputLimit = 128 * 1024;

export interface RunningToolItemOptions {
  id: string;
  toolCallId?: string;
  tool: string;
  args: unknown;
  description?: string;
  display?: ToolInputDisplay;
  startedAtMs?: number;
}

export function createRunningToolItem(options: RunningToolItemOptions): ToolTranscriptItem {
  const argsSummary = summarizeToolArgs(options.tool, options.args);
  const item: ToolTranscriptItem = {
    id: options.id,
    kind: "tool",
    toolCallId: options.toolCallId,
    tool: options.tool,
    description: options.description,
    title: semanticToolTitle(options.tool, argsSummary, options.display, options.description, true),
    argsSummary,
    display: options.display,
    status: "running",
    startedAtMs: options.startedAtMs
  };
  return { ...item, details: runningToolDetails(item) };
}

export function updateRunningToolItem(item: ToolTranscriptItem, update: ToolUpdate): ToolTranscriptItem {
  const percent = update.percent === undefined ? "" : `${String(update.percent)}% `;
  const text = update.text ?? update.kind;
  if ((update.kind === "stdout" || update.kind === "stderr") && update.text) {
    const output = `${item.output ?? ""}${update.text}`;
    const next = {
      ...item,
      output: output.length <= activeOutputLimit ? output : output.slice(-activeOutputLimit),
      progress: `${percent}${update.kind}`
    };
    return { ...next, details: runningToolDetails(next) };
  }
  const command = item.display?.kind === "command"
    ? item.display.command
    : item.tool === "run_command"
      ? item.argsSummary
      : undefined;
  if (command && (update.kind === "status" || Boolean(update.text?.includes(command)))) {
    // Shell status updates include the raw command and exit code. Both belong
    // in folded details, never in the active cell's primary output.
    return { ...item, progress: `${percent}Running…` };
  }
  return { ...item, progress: `${percent}${text}`.slice(0, 240) };
}

export function completeToolItem(
  item: ToolTranscriptItem,
  result: unknown,
  forcedStatus?: ToolTranscriptStatus,
  completedAtMs = Date.now()
): ToolTranscriptItem {
  const status = forcedStatus ?? toolStatusFromResult(result);
  const title = status === "skipped"
    ? interruptedToolTitle(item)
    : semanticToolTitle(item.tool, item.argsSummary, item.display, item.description, false);
  const projection = projectToolResult({ ...item, title }, result, status);
  return {
    ...item,
    title,
    status,
    startedAtMs: undefined,
    progress: undefined,
    output: projection.output,
    details: projection.details,
    durationMs: projection.durationMs ?? elapsedDuration(item.startedAtMs, completedAtMs),
    outputLines: projection.outputLines,
    exitCode: projection.exitCode,
    truncated: projection.truncated
  };
}

export function toolStatusFromResult(result: unknown): ToolTranscriptStatus {
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    if (record.status === "denied") return "denied";
    if (record.status === "failed" || record.status === "timed_out" || record.status === "aborted") return "failed";
    if (typeof record.exitCode === "number" && record.exitCode !== 0) return "failed";
    if ("error" in record) return "failed";
  }
  return "success";
}

export function summarizeToolArgs(tool: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : undefined;
  const query = typeof record.query === "string" ? record.query : undefined;
  const command = typeof record.command === "string" ? record.command : undefined;

  if ((tool === "read_file" || tool === "write_file" || tool === "edit_file") && path) return path;
  if ((tool === "search_files" || tool === "grep_search") && query) return query;
  if (tool === "web_search" && query) return query;
  if (tool === "list_files") return "workspace files";
  if (tool === "git_status") return "git status";
  if (tool === "git_diff") return "git diff";
  if (tool === "run_command" && command) return command;
  return summarizeValue(args, 800);
}

export function semanticToolTitle(
  tool: string,
  argsSummary: string,
  display: ToolInputDisplay | undefined,
  description: string | undefined,
  running: boolean
): string {
  if (tool === "run_command" || display?.kind === "command") {
    const command = display?.kind === "command" ? display.command : argsSummary;
    return semanticCommandTitle(command, running);
  }
  if (tool === "read_file") return `${running ? "Reading" : "Read"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "write_file") return `${running ? "Writing" : "Wrote"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "edit_file") return `${running ? "Editing" : "Edited"}${argsSummary ? ` ${argsSummary}` : " file"}`;
  if (tool === "list_files") return running ? "Listing workspace files" : "Listed workspace files";
  if (tool === "search_files" || tool === "grep_search") {
    return `${running ? "Searching" : "Searched"}${argsSummary ? ` for “${argsSummary}”` : " workspace"}`;
  }
  if (tool === "web_search") {
    return `${running ? "Searching the web" : "Searched the web"}${argsSummary ? ` for “${argsSummary}”` : ""}`;
  }
  if (tool === "git_status") return running ? "Checking git status" : "Checked git status";
  if (tool === "git_diff") return running ? "Reading git diff" : "Viewed git diff";
  const safeDescription = description?.trim();
  if (safeDescription && safeDescription.length <= 120) return safeDescription;
  return `${running ? "Running" : "Ran"} ${humanizeToolName(tool)}`;
}

export function toolDetailsText(item: ToolTranscriptItem): string | undefined {
  return item.details;
}

interface ToolResultProjection {
  output: string;
  details: string;
  durationMs?: number;
  outputLines?: number;
  exitCode?: number;
  truncated?: boolean;
}

function projectToolResult(item: ToolTranscriptItem, result: unknown, status: ToolTranscriptStatus): ToolResultProjection {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
  const durationMs = typeof record?.durationMs === "number" ? record.durationMs : undefined;
  const outputLines = typeof record?.outputLines === "number" ? record.outputLines : undefined;
  const exitCode = typeof record?.exitCode === "number" ? record.exitCode : undefined;
  const truncated = typeof record?.truncated === "boolean" ? record.truncated : undefined;

  if (item.tool === "web_search") return projectWebSearchResult(result, status, durationMs, outputLines, truncated);

  if (item.tool === "run_command" || item.display?.kind === "command") {
    const command = item.display?.kind === "command" ? item.display.command : item.argsSummary;
    const stdout = typeof record?.stdout === "string" ? record.stdout.trimEnd() : "";
    const error = typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : "";
    const stderr = typeof record?.stderr === "string" ? record.stderr.trimEnd() : error;
    const output = commandOutputPreview(stdout, stderr, status);
    return {
      output,
      details: [
        `Command: ${command || "(unknown)"}`,
        `Exit code: ${exitCode === undefined ? "unknown" : String(exitCode)}`,
        ...(stdout ? ["", "stdout:", stdout] : []),
        ...(stderr ? ["", "stderr:", stderr] : []),
        ...(!stdout && !stderr ? ["", "(no output)"] : [])
      ].join("\n"),
      durationMs,
      outputLines: outputLines ?? logicalLineCount([stdout, stderr].filter(Boolean).join("\n")),
      exitCode,
      truncated
    };
  }

  const formatted = formatToolResultSummary(item.tool, result);
  const rawOutput = extractOutput(result);
  const output = removeDuplicateTitle(formatted ?? rawOutput ?? summarizeValue(result, 64 * 1024), item.title)
    || (status === "success" ? "Completed" : status === "denied" ? "Denied" : "Failed");
  return {
    output,
    details: [
      item.argsSummary ? `Input: ${item.argsSummary}` : "",
      rawOutput ?? summarizeValue(result, 256 * 1024)
    ].filter(Boolean).join("\n\n"),
    durationMs,
    outputLines: outputLines ?? logicalLineCount(output),
    exitCode,
    truncated
  };
}

function projectWebSearchResult(
  result: unknown,
  status: ToolTranscriptStatus,
  durationMs: number | undefined,
  outputLines: number | undefined,
  truncated: boolean | undefined
): ToolResultProjection {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
  const error = typeof record?.error === "string"
    ? record.error
    : typeof record?.message === "string"
      ? record.message
      : undefined;
  if (status !== "success" || error) {
    const output = error ?? (status === "denied" ? "Denied" : "Web search failed");
    return { output, details: output, durationMs, outputLines: 1, truncated };
  }

  const query = typeof record?.query === "string" ? record.query : "(unknown)";
  const provider = typeof record?.provider === "string" ? record.provider : "web";
  const rawResults = Array.isArray(record?.results) ? record.results : [];
  const resultLines: string[] = [];
  for (const [index, rawResult] of rawResults.entries()) {
    if (typeof rawResult !== "object" || rawResult === null) continue;
    const item = rawResult as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const url = typeof item.url === "string" ? item.url : "";
    const snippet = typeof item.snippet === "string" ? item.snippet : "";
    if (!title || !url) continue;
    resultLines.push(`${index + 1}. ${title}`, `   ${url}`, ...(snippet ? [`   ${snippet}`] : []), "");
  }

  const output = resultLines.length > 0 ? resultLines.join("\n").trimEnd() : "No search results.";
  const details = [
    `Query: ${query}`,
    `Provider: ${provider}`,
    `Results: ${String(rawResults.length)}`,
    "",
    output
  ].join("\n");
  return {
    output,
    details,
    durationMs,
    outputLines: outputLines ?? logicalLineCount(output),
    truncated
  };
}

function commandOutputPreview(stdout: string, stderr: string, status: ToolTranscriptStatus): string {
  if (status === "failed" || status === "denied") return stderr || stdout || (status === "denied" ? "Denied" : "Command failed");
  if (stdout && stderr) return `${stdout}\nstderr:\n${stderr}`;
  return stdout || stderr || "Command completed";
}

function runningToolDetails(item: ToolTranscriptItem): string {
  if (item.tool === "run_command" || item.display?.kind === "command") {
    const command = item.display?.kind === "command" ? item.display.command : item.argsSummary;
    return [
      `Command: ${command || "(unknown)"}`,
      "Exit code: running",
      item.output ? `\noutput (live):\n${item.output}` : "\n(no output yet)"
    ].join("\n");
  }
  return item.argsSummary ? `Input: ${item.argsSummary}` : "Working…";
}

function interruptedToolTitle(item: ToolTranscriptItem): string {
  const title = item.title.replace(
    /^(?:Reading|Writing|Editing|Running|Checking|Listing|Searching|Building|Installing)\s*/u,
    "Interrupted "
  ).trimEnd();
  return title === item.title ? `Interrupted ${humanizeToolName(item.tool)}` : title;
}

function semanticCommandTitle(command: string, running: boolean): string {
  const normalized = command.trim().toLowerCase();
  const pair = (active: string, complete: string): string => running ? active : complete;
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|go test|cargo test)\b/.test(normalized)) {
    return pair("Running tests", "Ran tests");
  }
  if (/\btypecheck\b|\btsc\b[^\n]*(?:--noemit|-p\b)/.test(normalized)) return pair("Checking types", "Checked types");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|go)\s+build\b/.test(normalized)) {
    return pair("Building project", "Built project");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:install|add)\b/.test(normalized)) return pair("Installing dependencies", "Installed dependencies");
  if (/^(?:git\s+)?status\b|\bgit\s+status\b/.test(normalized)) return pair("Checking git status", "Checked git status");
  if (/\bgit\s+diff\b/.test(normalized)) return pair("Reading git diff", "Viewed git diff");
  if (/^(?:rg|grep)\b|\s(?:rg|grep)\s/.test(normalized)) return pair("Searching workspace", "Searched workspace");
  if (/^(?:ls|find)\b/.test(normalized)) return pair("Listing files", "Listed files");
  if (/^(?:cat|sed|head|tail)\b/.test(normalized)) return pair("Reading files", "Read files");
  return pair("Running command", "Ran command");
}

function removeDuplicateTitle(value: string, title: string): string {
  const [first = "", ...rest] = value.split("\n");
  if (first.trim() === title.trim() || title.endsWith(first.trim())) return rest.join("\n").trim();
  return value.trim();
}

function extractOutput(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return typeof result === "string" ? result : undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output.trimEnd();
  if (typeof record.content === "string") return record.content.trimEnd();
  if (typeof record.error === "string") return record.error;
  return undefined;
}

function summarizeValue(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    return JSON.stringify(value, null, 2).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function logicalLineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function elapsedDuration(startedAtMs: number | undefined, completedAtMs: number): number | undefined {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) return undefined;
  return Math.max(0, completedAtMs - startedAtMs);
}

function humanizeToolName(tool: string): string {
  return tool.replaceAll("_", " ");
}
