/**
 * Pure TUI state reducer.
 *
 * Completed transcript items are immutable history. Streaming assistant text
 * and running tools live in active cells and are updated in place until one
 * completion event commits each cell exactly once.
 */
import type { RuntimeEvent } from "../runtime/events.js";
import {
  completeToolItem,
  createRunningToolItem,
  updateRunningToolItem
} from "./toolPresentation.js";
import type {
  ActiveTranscriptItem,
  AssistantTranscriptItem,
  NotificationTranscriptItem,
  ReasoningTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  TranscriptState,
  TuiState
} from "./types.js";

export type TuiAction = RuntimeEvent
  | { type: "transcript.cleared" }
  | { type: "transcript.replaced"; items: TranscriptItem[]; viewingSessionId?: string }
  | { type: "permission.details.toggled" };

export function createInitialTuiState(workspaceRoot: string): TuiState {
  return {
    cwd: workspaceRoot,
    provider: "No model",
    modelLabel: "No model",
    reasoningLabel: "Not configured",
    sessionId: "",
    sessionFile: "",
    viewingSessionId: undefined,
    status: "idle",
    turnStartedAt: undefined,
    lastWorkedMs: undefined,
    transcript: { committed: [], active: [] },
    permissionDetailsExpanded: false
  };
}

export function tuiReducer(state: TuiState, event: TuiAction): TuiState {
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        cwd: event.cwd,
        provider: event.provider,
        modelLabel: event.modelLabel,
        reasoningLabel: event.reasoningLabel,
        sessionId: event.sessionId,
        sessionFile: event.sessionFile,
        viewingSessionId: event.sessionId,
        status: "idle",
        turnStartedAt: undefined,
        lastWorkedMs: undefined
      };
    case "model.changed":
      return { ...state, provider: event.provider, modelLabel: event.modelLabel, reasoningLabel: event.reasoningLabel };
    case "runtime.status":
      return { ...state, status: event.status };
    case "session.completed": {
      const transcript = finalizeActiveCells(state.transcript, "skipped", "Interrupted before completion.");
      return {
        ...state,
        status: state.status === "error" ? "error" : "completed",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript
      };
    }
    case "session.incomplete": {
      const finalized = finalizeActiveCells(state.transcript, "skipped", event.message);
      return {
        ...state,
        status: "incomplete",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, event.message))
      };
    }
    case "session.aborted": {
      const finalized = finalizeActiveCells(state.transcript, "skipped", event.message);
      return {
        ...state,
        status: "aborted",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, event.message))
      };
    }
    case "session.error": {
      const finalized = finalizeActiveCells(state.transcript, "failed", event.message);
      return {
        ...state,
        status: "error",
        permission: undefined,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, {
          id: nextTranscriptId(finalized, "error"),
          kind: "error",
          content: event.message
        })
      };
    }
    case "error.message":
      return {
        ...state,
        status: "error",
        transcript: commitItem(state.transcript, {
          id: nextTranscriptId(state.transcript, "error"),
          kind: "error",
          content: event.message
        })
      };
    case "system.message":
      return {
        ...state,
        transcript: commitItem(state.transcript, notificationItem(state.transcript, event.content))
      };
    case "transcript.cleared":
      return {
        ...state,
        transcript: { committed: [], active: [] }
      };
    case "transcript.replaced":
      return replaceTranscript(state, event.items, event.viewingSessionId);
    case "permission.details.toggled":
      return { ...state, permissionDetailsExpanded: !state.permissionDetailsExpanded };
    case "user.message":
      return {
        ...state,
        viewingSessionId: state.sessionId,
        status: "thinking",
        turnStartedAt: Date.now(),
        lastWorkedMs: undefined,
        transcript: commitItem(state.transcript, {
          id: nextTranscriptId(state.transcript, "user"),
          kind: "user",
          content: event.content
        })
      };
    case "reasoning.delta":
      return {
        ...state,
        status: "thinking",
        transcript: updateReasoningDelta(state.transcript, event.content)
      };
    case "reasoning.completed":
      return {
        ...state,
        transcript: commitReasoning(state.transcript)
      };
    case "assistant.delta":
      return {
        ...state,
        status: "thinking",
        transcript: updateAssistantDelta(commitReasoning(state.transcript), event.content)
      };
    case "assistant.completed":
      return {
        ...state,
        status: "completed",
        transcript: commitAssistant(commitReasoning(state.transcript), event.content)
      };
    case "tool.call.started":
      return {
        ...state,
        status: "running",
        transcript: startTool(commitReasoning(state.transcript), event)
      };
    case "tool.call.progress":
      return {
        ...state,
        status: "running",
        transcript: updateTool(state.transcript, event.toolCallId, event.tool, (item) => updateRunningToolItem(item, event.update))
      };
    case "tool.call.completed":
      return {
        ...state,
        status: "running",
        transcript: finishTool(state.transcript, event.toolCallId, event.tool, event.result)
      };
    case "tool.call.failed":
      return {
        ...state,
        status: "error",
        transcript: finishTool(state.transcript, event.toolCallId, event.tool, { error: event.error }, "failed")
      };
    case "permission.requested":
      return {
        ...state,
        status: "waiting_permission",
        permission: {
          tool: event.tool,
          title: event.title,
          details: event.details,
          requireFullYes: event.requireFullYes,
          diff: event.diff,
          preview: event.preview,
          actionType: event.actionType,
          riskLevel: event.riskLevel,
          targetPath: event.targetPath,
          command: event.command,
          reason: event.reason,
          changeSummary: event.changeSummary
        }
      };
    case "permission.approved":
      return { ...state, status: "running", permission: undefined };
    case "permission.rejected":
      return { ...state, status: "running", permission: undefined };
    case "permission.status.changed":
      return {
        ...state,
        transcript: commitItem(state.transcript, {
          ...notificationItem(state.transcript, event.message),
          tone: "success"
        })
      };
  }
}

function updateAssistantDelta(transcript: TranscriptState, content: string): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "assistant");
  if (index === -1) {
    return {
      ...transcript,
      active: [
        ...transcript.active,
        { id: nextTranscriptId(transcript, "assistant"), kind: "assistant", content }
      ]
    };
  }
  const active = [...transcript.active];
  const item = active[index] as AssistantTranscriptItem;
  active[index] = { ...item, content: `${item.content}${content}` };
  return { ...transcript, active };
}

function updateReasoningDelta(transcript: TranscriptState, content: string): TranscriptState {
  if (!content) return transcript;
  const index = transcript.active.findIndex((item) => item.kind === "reasoning");
  if (index === -1) {
    return {
      ...transcript,
      active: [
        ...transcript.active,
        { id: nextTranscriptId(transcript, "reasoning"), kind: "reasoning", content }
      ]
    };
  }
  const active = [...transcript.active];
  const item = active[index] as ReasoningTranscriptItem;
  active[index] = { ...item, content: `${item.content}${content}` };
  return { ...transcript, active };
}

function commitReasoning(transcript: TranscriptState): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "reasoning");
  if (index === -1) return transcript;
  const item = transcript.active[index];
  const active = transcript.active.filter((_, itemIndex) => itemIndex !== index);
  if (!item || item.kind !== "reasoning" || !item.content) return { ...transcript, active };
  return { committed: [...transcript.committed, item], active };
}

function commitAssistant(transcript: TranscriptState, content: string): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "assistant");
  const activeItem = index === -1 ? undefined : transcript.active[index] as AssistantTranscriptItem;
  const finalContent = content || activeItem?.content || "";
  const active = index === -1 ? transcript.active : transcript.active.filter((_, itemIndex) => itemIndex !== index);
  if (!finalContent) return { ...transcript, active };
  const item: AssistantTranscriptItem = {
    id: activeItem?.id ?? nextTranscriptId(transcript, "assistant"),
    kind: "assistant",
    content: finalContent
  };
  return { committed: [...transcript.committed, item], active };
}

function startTool(
  transcript: TranscriptState,
  event: Extract<RuntimeEvent, { type: "tool.call.started" }>
): TranscriptState {
  const existing = event.toolCallId === undefined
    ? -1
    : transcript.active.findIndex((item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
  const item = createRunningToolItem({
    id: existing === -1
      ? nextTranscriptId(transcript, `tool-${event.tool}`)
      : transcript.active[existing]?.id ?? nextTranscriptId(transcript, `tool-${event.tool}`),
    toolCallId: event.toolCallId,
    tool: event.tool,
    args: event.args,
    description: event.description,
    display: event.display,
    startedAtMs: Date.now()
  });
  if (existing === -1) return { ...transcript, active: [...transcript.active, item] };
  const active = [...transcript.active];
  active[existing] = item;
  return { ...transcript, active };
}

function updateTool(
  transcript: TranscriptState,
  toolCallId: string | undefined,
  tool: string,
  update: (item: ToolTranscriptItem) => ToolTranscriptItem
): TranscriptState {
  const index = findActiveToolIndex(transcript.active, toolCallId, tool);
  if (index === -1) return transcript;
  const item = transcript.active[index];
  if (item?.kind !== "tool") return transcript;
  const active = [...transcript.active];
  active[index] = update(item);
  return { ...transcript, active };
}

function finishTool(
  transcript: TranscriptState,
  toolCallId: string | undefined,
  tool: string,
  result: unknown,
  forcedStatus?: ToolTranscriptItem["status"]
): TranscriptState {
  const index = findActiveToolIndex(transcript.active, toolCallId, tool);
  if (index === -1 && toolCallId && transcript.committed.some((item) => item.kind === "tool" && item.toolCallId === toolCallId)) {
    return transcript;
  }
  const running = index === -1
    ? createRunningToolItem({
      id: nextTranscriptId(transcript, `tool-${tool}`),
      toolCallId,
      tool,
      args: {},
      startedAtMs: Date.now()
    })
    : transcript.active[index];
  if (!running || running.kind !== "tool") return transcript;
  const completed = completeToolItem(running, result, forcedStatus);
  const active = index === -1 ? transcript.active : transcript.active.filter((_, itemIndex) => itemIndex !== index);
  return { committed: [...transcript.committed, completed], active };
}

function findActiveToolIndex(active: ActiveTranscriptItem[], toolCallId: string | undefined, tool: string): number {
  if (toolCallId) {
    return active.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
  }
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const item = active[index];
    if (item?.kind === "tool" && item.tool === tool && item.status === "running") return index;
  }
  return -1;
}

function commitItem(transcript: TranscriptState, item: TranscriptItem): TranscriptState {
  return { ...transcript, committed: [...transcript.committed, item] };
}

function notificationItem(transcript: TranscriptState, content: string): NotificationTranscriptItem {
  return { id: nextTranscriptId(transcript, "notification"), kind: "notification", content, tone: "muted" };
}

function nextTranscriptId(transcript: TranscriptState, prefix: string): string {
  return `${prefix}-${String(transcript.committed.length + transcript.active.length + 1)}`;
}

function replaceTranscript(state: TuiState, items: TranscriptItem[], viewingSessionId: string | undefined): TuiState {
  return {
    ...state,
    viewingSessionId,
    transcript: { committed: items, active: [] },
    turnStartedAt: undefined,
    lastWorkedMs: undefined
  };
}

function finalizeActiveCells(
  transcript: TranscriptState,
  toolStatus: "failed" | "skipped",
  message: string
): TranscriptState {
  if (transcript.active.length === 0) return transcript;
  const committed = [...transcript.committed];
  for (const item of transcript.active) {
    if (item.kind === "reasoning") {
      if (item.content) committed.push(item);
      continue;
    }
    if (item.kind === "assistant") {
      if (item.content) committed.push(item);
      continue;
    }
    committed.push(completeToolItem(item, { error: message }, toolStatus));
  }
  return { committed, active: [] };
}
