import type { ToolInputDisplay, ToolUpdate } from "../../../tools/types.js";
import type { AgentPermissionEventRequest, AgentRunModel, AgentHostEvent } from "../../../runtime/agentEvents.js";
import type { SessionEvent } from "../../../session/recorder.js";
import type { SessionUsage } from "../../../session/metadata.js";

export type TimelineRunStatus = "idle" | "queued" | "running" | "waiting_permission" | "completed" | "incomplete" | "aborted" | "failed";
export type TimelineToolStatus = "waiting" | "running" | "success" | "failed" | "denied" | "aborted";

export interface TimelinePermission {
  requestId: string;
  request: AgentPermissionEventRequest;
  resolved: boolean;
  approved?: boolean;
  message?: string;
}

export interface TimelineCommand {
  command: string;
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface TimelineTool {
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: TimelineToolStatus;
  description?: string;
  display?: ToolInputDisplay;
  updates: ToolUpdate[];
  durationMs?: number;
  error?: string;
  diff?: string;
  path?: string;
  command?: TimelineCommand;
  permission?: TimelinePermission;
  timestamp?: string;
}

export interface TimelineToolEntry {
  key: string;
  label: string;
  toolId?: string;
}

export function activeTimelineTool(tools: TimelineTool[], selectedToolId?: string): TimelineTool | undefined {
  return [...tools].reverse().find((tool) => tool.permission && !tool.permission.resolved)
    ?? tools.find((tool) => tool.id === selectedToolId);
}

export function timelineToolEntries(tools: TimelineTool[]): TimelineToolEntry[] {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const tool of tools) totals.set(tool.tool, (totals.get(tool.tool) ?? 0) + 1);
  return tools.map((tool) => {
    const occurrence = (seen.get(tool.tool) ?? 0) + 1;
    seen.set(tool.tool, occurrence);
    const duplicateLabel = (totals.get(tool.tool) ?? 0) > 1 ? ` ${String(occurrence)}` : "";
    const permissionLabel = tool.permission && !tool.permission.resolved ? " · 待授权" : "";
    return {
      key: tool.id,
      label: `${executionToolLabel(tool.tool)}${duplicateLabel}${permissionLabel}`,
      toolId: tool.id
    };
  });
}

function executionToolLabel(tool: string): string {
  if (tool === "run_command") return "Bash";
  if (tool === "invoke_skill" || tool === "skill_call") return "技能调用";
  return tool;
}

export interface TimelineTurn {
  id: string;
  user: string;
  userMessageIndex?: number;
  assistant: string;
  reasoning: string;
  reasoningStatus?: string;
  reasoningDurationMs?: number;
  reasoningStartedAt?: string;
  skills: string[];
  status: TimelineRunStatus;
  model?: AgentRunModel;
  tools: TimelineTool[];
  error?: string;
  durationMs?: number;
  usage?: SessionUsage;
  timestamp?: string;
}

export interface TimelineChangedFile {
  path: string;
  operation: "write" | "edit";
  status: "writing" | "completed";
}

export function buildSessionTimeline(events: SessionEvent[], liveEvents: AgentHostEvent[]): TimelineTurn[] {
  const history = historicalPrefix(events, liveEvents);
  const historicalTurns = buildHistoricalTurns(history);
  const historicalUserMessages = history.filter((event) => event.type === "user_message").length;
  return [...historicalTurns, ...buildLiveTurns(liveEvents, historicalUserMessages)].filter((turn) => turn.user || turn.assistant || turn.tools.length || turn.error);
}

function historicalPrefix(events: SessionEvent[], liveEvents: AgentHostEvent[]): SessionEvent[] {
  const firstLiveUser = liveEvents.find((event) => event.type === "message.user");
  if (!firstLiveUser || firstLiveUser.type !== "message.user") return events;
  const liveTimestamp = Date.parse(firstLiveUser.timestamp);
  if (Number.isNaN(liveTimestamp)) return events;
  let matchingIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "user_message" || event.content !== firstLiveUser.content) continue;
    const eventTimestamp = event.time ? Date.parse(event.time) : Number.NaN;
    // The live event is emitted before AgentSession records the user message. An
    // older identical prompt must therefore stay in the historical prefix.
    if (!Number.isNaN(eventTimestamp) && eventTimestamp >= liveTimestamp) matchingIndex = index;
  }
  return matchingIndex >= 0 ? events.slice(0, matchingIndex) : events;
}

function buildHistoricalTurns(events: SessionEvent[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  let anonymousIndex = 0;
  let userMessageIndex = 0;
  const ensureTurn = (timestamp?: string): TimelineTurn => {
    if (current) return current;
    anonymousIndex += 1;
    current = emptyTurn(`history-${String(anonymousIndex)}`, timestamp);
    turns.push(current);
    return current;
  };

  for (const event of events) {
    if (event.type === "user_message") {
      anonymousIndex += 1;
      current = emptyTurn(`history-${String(anonymousIndex)}`, event.time);
      current.user = event.content;
      current.userMessageIndex = userMessageIndex;
      userMessageIndex += 1;
      current.skills = skillNames(event.skills);
      turns.push(current);
      continue;
    }
    if (event.type === "assistant_message") {
      const turn = ensureTurn(event.time);
      turn.assistant = event.content || turn.assistant;
      turn.reasoning = appendReasoning(turn.reasoning, event.reasoningContent);
      turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.status = "completed";
      turn.usage = event.usage;
      if (event.usage) {
        turn.model = {
          alias: event.usage.modelAlias,
          provider: event.usage.provider,
          label: modelLabel(event.usage.provider, event.usage.model),
          reasoning: ""
        };
      }
      continue;
    }
    if (event.type === "tool_call") {
      const turn = ensureTurn(event.time);
      const projection = historicalToolProjection(event.tool, event.args);
      turn.reasoning = appendReasoning(turn.reasoning, event.reasoningContent);
      turn.tools.push({
        id: event.toolCallId ?? `history-tool-${String(turn.tools.length)}`,
        tool: event.tool,
        args: event.args,
        status: "running",
        display: projection.display,
        path: projection.path,
        updates: [],
        timestamp: event.time
      });
      continue;
    }
    if (event.type === "tool_result") {
      const turn = ensureTurn(event.time);
      const tool = [...turn.tools].reverse().find((candidate) => candidate.id === event.toolCallId || (candidate.tool === event.tool && candidate.result === undefined));
      if (tool) {
        tool.result = event.result;
        tool.status = resultFailed(event.result) ? "failed" : "success";
        tool.error = resultError(event.result);
        tool.diff = resultString(event.result, "output") ?? resultString(event.result, "diffPreview");
      }
      continue;
    }
    const turn = ensureTurn(event.time);
    turn.error = event.message;
    turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
    turn.timestamp = event.time ?? turn.timestamp;
    const aborted = /abort|中止|interrupted/i.test(event.message);
    turn.status = aborted ? "aborted" : "failed";
    if (aborted) {
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "failed") tool.status = "aborted";
      }
    }
  }
  return turns;
}

function buildLiveTurns(events: AgentHostEvent[], initialUserMessageIndex: number): TimelineTurn[] {
  const turns = new Map<string, TimelineTurn>();
  const order: string[] = [];
  const toolMaps = new Map<string, Map<string, TimelineTool>>();
  let userMessageIndex = initialUserMessageIndex;
  const turnFor = (event: AgentHostEvent): TimelineTurn => {
    const current = turns.get(event.runId);
    if (current) return current;
    const turn = emptyTurn(event.runId, event.timestamp);
    turns.set(event.runId, turn);
    toolMaps.set(event.runId, new Map());
    order.push(event.runId);
    return turn;
  };
  const toolFor = (event: AgentHostEvent & { toolCallId: string }, toolName = "tool"): TimelineTool => {
    const turn = turnFor(event);
    const tools = toolMaps.get(event.runId);
    if (!tools) throw new Error("Timeline tool map is missing.");
    const current = tools.get(event.toolCallId);
    if (current) return current;
    const tool: TimelineTool = {
      id: event.toolCallId,
      tool: toolName,
      args: {},
      status: "waiting",
      updates: [],
      timestamp: event.timestamp
    };
    tools.set(event.toolCallId, tool);
    turn.tools.push(tool);
    return tool;
  };

  for (const event of events) {
    const turn = turnFor(event);
    if (event.type === "message.user") {
      turn.user = event.content;
      turn.userMessageIndex = userMessageIndex;
      userMessageIndex += 1;
      turn.status = "queued";
    } else if (event.type === "run.started") {
      turn.status = "running";
      turn.model = event.model;
      turn.skills = skillNames(event.skills);
    } else if (event.type === "assistant.delta") {
      turn.assistant += event.content;
    } else if (event.type === "assistant.completed") {
      turn.assistant = event.content || turn.assistant;
      turn.timestamp = event.timestamp;
    } else if (event.type === "reasoning.started") {
      turn.reasoningStatus = event.status;
      if (turn.reasoningStartedAt === undefined) turn.reasoningStartedAt = event.timestamp;
    } else if (event.type === "reasoning.delta") {
      turn.reasoning += event.content;
    } else if (event.type === "reasoning.status") {
      turn.reasoningStatus = event.status;
    } else if (event.type === "reasoning.completed") {
      turn.reasoningStatus = event.status;
      turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, event.timestamp);
      turn.reasoningStartedAt = undefined;
    } else if (event.type === "tool.started") {
      const tool = toolFor(event, event.tool);
      tool.tool = event.tool;
      tool.args = event.args;
      tool.status = "running";
      tool.description = event.description;
      tool.display = event.display;
      if (event.display?.kind === "file_io") tool.path = event.display.path;
    } else if (event.type === "tool.progress") {
      const tool = toolFor(event, event.tool);
      tool.updates.push(event.update);
    } else if (event.type === "tool.completed") {
      const tool = toolFor(event, event.tool);
      tool.result = event.result;
      tool.status = "success";
      tool.durationMs = event.durationMs;
    } else if (event.type === "tool.failed") {
      const tool = toolFor(event, event.tool);
      tool.status = "failed";
      tool.error = event.error;
      tool.durationMs = event.durationMs;
    } else if (event.type === "permission.requested") {
      const tool = toolFor(event, event.request.tool);
      tool.status = "running";
      tool.permission = { requestId: event.requestId, request: event.request, resolved: false };
      turn.status = "waiting_permission";
    } else if (event.type === "permission.resolved") {
      const tool = toolFor(event, event.tool);
      tool.permission = {
        requestId: event.requestId,
        request: tool.permission?.request ?? permissionFallback(event.toolCallId, event.tool),
        resolved: true,
        approved: event.approved,
        message: event.message
      };
      if (!event.approved) tool.status = "denied";
      turn.status = "running";
    } else if (event.type === "command.started") {
      const tool = toolFor(event, "run_command");
      tool.command = { command: event.command, cwd: event.cwd, stdout: "", stderr: "" };
    } else if (event.type === "command.output") {
      const tool = toolFor(event, "run_command");
      tool.command ??= { command: "", stdout: "", stderr: "" };
      if (event.stream === "stderr") tool.command.stderr += event.content;
      if (event.stream === "stdout") tool.command.stdout += event.content;
    } else if (event.type === "command.completed") {
      const tool = toolFor(event, "run_command");
      tool.command ??= { command: event.command, cwd: event.cwd, stdout: "", stderr: "" };
      tool.command.exitCode = event.exitCode;
      tool.durationMs = event.durationMs;
      if (event.exitCode !== undefined && event.exitCode !== 0) {
        tool.status = "failed";
        tool.error ??= `Command exited with code ${String(event.exitCode)}.`;
      }
    } else if (event.type === "command.failed") {
      const tool = toolFor(event, "run_command");
      tool.command ??= { command: event.command, cwd: event.cwd, stdout: "", stderr: "" };
      tool.command.exitCode = event.exitCode;
      tool.status = "failed";
      tool.error = event.error;
      tool.durationMs = event.durationMs;
    } else if (event.type === "file.read" || event.type === "file.changed") {
      const tool = toolFor(event, event.type === "file.read" ? "read_file" : event.operation === "write" ? "write_file" : "edit_file");
      tool.path = event.path;
      if (event.type === "file.changed") tool.display ??= { kind: "file_io", operation: event.operation, path: event.path };
    } else if (event.type === "diff.created") {
      const tool = toolFor(event, "git_diff");
      tool.diff = event.diff;
      tool.path = event.path;
    } else if (event.type === "run.completed") {
      turn.status = "completed";
      turn.timestamp = event.timestamp;
      turn.durationMs = event.durationMs;
      turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, event.timestamp);
      turn.reasoningStartedAt = undefined;
      turn.usage = event.usage;
    } else if (event.type === "run.incomplete") {
      turn.status = "incomplete";
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, event.timestamp);
      turn.reasoningStartedAt = undefined;
      turn.usage = event.usage;
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "waiting") tool.status = "aborted";
      }
    } else if (event.type === "run.aborted") {
      turn.status = "aborted";
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, event.timestamp);
      turn.reasoningStartedAt = undefined;
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "waiting") tool.status = "aborted";
      }
    } else if (event.type === "run.failed") {
      turn.status = "failed";
      turn.timestamp = event.timestamp;
      turn.error = event.error;
      turn.durationMs = event.durationMs;
      turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, event.timestamp);
      turn.reasoningStartedAt = undefined;
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "waiting") tool.status = "failed";
      }
    }
  }
  return order.map((runId) => turns.get(runId)).filter((turn): turn is TimelineTurn => Boolean(turn));
}

function emptyTurn(id: string, timestamp?: string): TimelineTurn {
  return { id, user: "", assistant: "", reasoning: "", skills: [], status: "idle", tools: [], timestamp };
}

function appendReasoning(existing: string, next: string | undefined): string {
  if (!next) return existing;
  if (!existing) return next;
  if (existing.endsWith(next)) return existing;
  return `${existing}\n\n${next}`;
}

function skillNames(paths: string[] | undefined): string[] {
  const names = (paths ?? []).map(skillName).filter(Boolean);
  return [...new Set(names)];
}

function skillName(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? value;
  const stem = fileName.replace(/\.(?:md|markdown)$/i, "");
  return /^skill$/i.test(stem) && parts.length > 1 ? parts.at(-2) ?? stem : stem;
}

function addReasoningDuration(total: number | undefined, startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) return total;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return total;
  return (total ?? 0) + end - start;
}

function elapsedMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

function permissionFallback(toolCallId: string, tool: string): AgentPermissionEventRequest {
  return {
    toolCallId,
    tool,
    title: `允许执行 ${tool}`,
    details: "此权限请求已恢复。",
    requireFullYes: false,
    actionType: "unknown",
    riskLevel: "unknown"
  };
}

function resultFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.error === "string"
    || (typeof record.exitCode === "number" && record.exitCode !== 0)
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.status === "denied";
}

function resultError(result: unknown): string | undefined {
  return resultString(result, "error") ?? (resultFailed(result) ? "工具执行失败" : undefined);
}

function resultString(result: unknown, key: string): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function modelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}

function historicalToolProjection(tool: string, args: unknown): { display?: ToolInputDisplay; path?: string } {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : undefined;
  const path = typeof record?.path === "string" ? record.path : undefined;
  const query = typeof record?.query === "string" ? record.query : undefined;
  if (tool === "read_file" || tool === "write_file" || tool === "edit_file") {
    const operation = tool === "read_file" ? "read" : tool === "write_file" ? "write" : "edit";
    return { path, display: { kind: "file_io", operation, path } };
  }
  if (tool === "search_files" || tool === "grep_search") {
    return {
      path: undefined,
      display: { kind: "file_io", operation: tool === "search_files" ? "search" : "grep", path: ".", detail: query }
    };
  }
  if (tool === "list_files") return { path: undefined, display: { kind: "file_io", operation: "list", path: "." } };
  if (tool === "git_diff" || tool === "git_status") {
    return { path: undefined, display: { kind: "file_io", operation: "git", path: ".", detail: tool === "git_diff" ? "git diff" : "git status --short" } };
  }
  return { path: undefined, display: undefined };
}

export function listChangedFiles(turn: TimelineTurn): TimelineChangedFile[] {
  const files = new Map<string, TimelineChangedFile>();
  for (const tool of turn.tools) {
    const operation = changedFileOperation(tool);
    const path = tool.path ?? (tool.display?.kind === "file_io" ? tool.display.path : undefined);
    if (!operation || !path || tool.status === "failed" || tool.status === "denied" || tool.status === "aborted") continue;
    files.set(path, {
      path,
      operation,
      status: tool.status === "success" ? "completed" : "writing"
    });
  }
  return [...files.values()];
}

export function listTimelineFiles(turns: TimelineTurn[]): TimelineChangedFile[] {
  const files = new Map<string, TimelineChangedFile>();
  for (const turn of turns) {
    for (const file of listChangedFiles(turn)) {
      if (file.status !== "completed") continue;
      files.delete(file.path);
      files.set(file.path, file);
    }
  }
  return [...files.values()].reverse();
}

function changedFileOperation(tool: TimelineTool): TimelineChangedFile["operation"] | undefined {
  if (tool.display?.kind === "file_io" && (tool.display.operation === "write" || tool.display.operation === "edit")) return tool.display.operation;
  if (tool.tool === "write_file") return "write";
  if (tool.tool === "edit_file") return "edit";
  return undefined;
}
