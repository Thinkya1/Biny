import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { listSessionSummaries, readSessionEvents, type SessionSummary } from "../session/events.js";
import { resolveSessionFile } from "../session/store.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { formatProjectContext } from "../project/ProjectContext.js";
import { createInitialTuiState, tuiReducer } from "./reducer.js";
import { Header } from "./components/Header.js";
import { MessageList } from "./components/MessageList.js";
import { MessageItem } from "./components/MessageItem.js";
import { InputBox } from "./components/InputBox.js";
import { StatusBar } from "./components/StatusBar.js";
import { ToolCallView } from "./components/ToolCallView.js";
import { TurnStatus } from "./components/TurnStatus.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { createTuiRuntime, type TuiRuntime } from "./runtime/createTuiRuntime.js";
import type { PermissionChoice } from "./types.js";
import { TUI_SLASH_COMMANDS } from "./slashCommands.js";
import { sessionEventsToMessages, sessionIdFromFile } from "./sessionTranscript.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";

export interface AppProps {
  workspaceRoot: string;
  onExitSummary?: (summary: TuiExitSummary) => void;
}

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

export function App({ workspaceRoot, onExitSummary }: AppProps): React.ReactElement {
  const [state, dispatch] = useReducer(tuiReducer, workspaceRoot, createInitialTuiState);
  const [startupError, setStartupError] = useState<string | undefined>(undefined);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<"chat" | "plan">("chat");
  const [previewMode, setPreviewMode] = useState<"chat" | "plan" | undefined>(undefined);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: SessionSummary[]; selectedIndex: number; query: string } | undefined>(undefined);
  const runtimeRef = useRef<TuiRuntime | undefined>(undefined);
  const exitingRef = useRef(false);
  const app = useApp();
  const { rows } = useWindowSize();

  useEffect(() => {
    let disposed = false;
    void createTuiRuntime(workspaceRoot)
      .then((runtime) => {
        if (disposed) {
          void runtime.close();
          return;
        }
        runtimeRef.current = runtime;
        void loadInputHistory(runtime.commandRuntime.workspaceRoot)
          .then(setInputHistory)
          .catch((error) => {
            dispatch({ type: "system.message", content: `读取输入历史失败：${error instanceof Error ? error.message : String(error)}` });
          });
        runtime.subscribe(dispatch);
        dispatch({
          type: "session.started",
          sessionId: runtime.commandRuntime.recorder.sessionId,
          sessionFile: runtime.commandRuntime.recorder.filePath,
          cwd: runtime.commandRuntime.workspaceRoot,
          provider: runtime.commandRuntime.config.model.provider,
          modelLabel: formatModelLabel(runtime.commandRuntime.config.model.provider, runtime.commandRuntime.config.model.model)
        });
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      void runtimeRef.current?.close();
    };
  }, [workspaceRoot]);

  useInput((input, key) => {
    const isBusy = state.status === "thinking" || state.status === "running" || state.status === "waiting_permission";
    if (key.ctrl && input.toLowerCase() === "o") {
      dispatch({ type: "tool.details.toggled" });
      return;
    }
    if (key.pageUp) {
      dispatch({ type: "messages.scrolled", direction: 1, amount: Math.max(1, rows - 12) });
      return;
    }
    if (key.pageDown) {
      dispatch({ type: "messages.scrolled", direction: -1, amount: Math.max(1, rows - 12) });
      return;
    }
    if (key.end) {
      dispatch({ type: "messages.follow_latest" });
      return;
    }
    if (key.escape && isBusy) {
      runtimeRef.current?.cancelCurrentTurn();
      return;
    }
    if (key.ctrl && input === "c") {
      if (isBusy) {
        runtimeRef.current?.cancelCurrentTurn();
        return;
      }
      void closeAndExit();
    }
  });

  const sendPrompt = (value: string): void => {
    setPreviewMode(undefined);
    if (state.status === "thinking" || state.status === "running") {
      dispatch({ type: "system.message", content: "当前暂不支持 Ctrl-S 注入；请等待当前轮次结束，或按 Esc / Ctrl+C 中断。" });
      return;
    }
    if (isKnownSlashCommand(value)) {
      void handleSlashCommand(value);
      return;
    }
    if (mode === "plan") {
      void createTuiPlan(value);
      return;
    }
    void runtimeRef.current?.sendPrompt(value);
  };

  const appendHistory = (value: string): void => {
    setInputHistory((current) => [...current, value].slice(-100));
    void appendInputHistory(workspaceRoot, value).catch((error) => {
      dispatch({ type: "system.message", content: `写入输入历史失败：${error instanceof Error ? error.message : String(error)}` });
    });
  };

  const answerPermission = (choice: PermissionChoice): void => {
    runtimeRef.current?.answerPermission(choice);
  };

  const filteredSessionPicker = sessionPicker
    ? {
      ...sessionPicker,
      sessions: filterSessions(sessionPicker.sessions, sessionPicker.query)
    }
    : undefined;
  const transcript = splitTranscript(state.messages, state.status);

  const togglePlanMode = (): void => {
    setPreviewMode(undefined);
    setMode((current) => {
      const next = current === "plan" ? "chat" : "plan";
      dispatch({ type: "system.message", content: next === "plan" ? "已进入 Plan 模式：后续输入只生成计划，不执行工具或修改文件。" : "已回到 Chat 模式。" });
      return next;
    });
  };

  const previewSlashCommand = useCallback((commandName: string | undefined): void => {
    setPreviewMode(commandName === "/plan" ? "plan" : undefined);
  }, []);

  if (startupError) {
    return (
      <Box flexDirection="column">
        <Text color="red">TUI startup failed: {startupError}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {filteredSessionPicker ? null : (
        <Static items={transcript.staticMessages}>
          {(message, index) => (
            <StaticTranscriptItem
              key={message.id}
              message={message}
              showSeparator={shouldShowSeparator(transcript.staticMessages, index)}
            />
          )}
        </Static>
      )}
      <Box flexDirection="column" flexShrink={0}>
        <Box flexShrink={0} width="100%">
          <Header sessionId={state.sessionId} viewingSessionId={state.viewingSessionId} />
        </Box>
        <Box flexDirection="column">
          {filteredSessionPicker ? (
          <SessionPicker
            sessions={filteredSessionPicker.sessions}
            selectedIndex={Math.min(filteredSessionPicker.selectedIndex, Math.max(0, filteredSessionPicker.sessions.length - 1))}
            query={filteredSessionPicker.query}
            onQueryChange={(query) => setSessionPicker((current) => current ? { ...current, query, selectedIndex: 0 } : current)}
            onMove={(direction) => setSessionPicker((current) => {
              if (!current) return current;
              const sessions = filterSessions(current.sessions, current.query);
              const selectedIndex = sessions.length
                ? (current.selectedIndex + direction + sessions.length) % sessions.length
                : 0;
              return { ...current, selectedIndex };
            })}
            onSelect={() => {
              const selected = filteredSessionPicker.sessions[Math.min(filteredSessionPicker.selectedIndex, filteredSessionPicker.sessions.length - 1)];
              if (selected) {
                setSessionPicker(undefined);
                void resumeSessionById(selected.fileName.replace(/\.jsonl$/, ""));
              }
            }}
            onExit={() => setSessionPicker(undefined)}
          />
        ) : (
          <MessageList
            messages={transcript.liveMessages}
            visibleCount={Math.max(1, rows - 12)}
            scrollOffset={state.messageScrollOffset}
            followLatest={state.followLatest}
          />
        )}
        <ToolCallView toolCalls={state.toolCalls} expanded={state.toolDetailsExpanded} />
        <PermissionPrompt
          request={state.permission}
          detailsExpanded={state.permissionDetailsExpanded}
          onAnswer={answerPermission}
          onToggleDetails={() => dispatch({ type: "permission.details.toggled" })}
        />
        {filteredSessionPicker ? null : (
          <TurnStatus status={state.status} turnStartedAt={state.turnStartedAt} lastWorkedMs={state.lastWorkedMs} />
        )}
        </Box>
        {filteredSessionPicker ? null : (
          <Box flexShrink={0} width="100%">
            <InputBox
              disabled={state.status === "waiting_permission"}
              busy={state.status === "thinking" || state.status === "running"}
              hasToolCalls={state.toolCalls.length > 0}
              slashCommands={TUI_SLASH_COMMANDS}
              initialHistory={inputHistory}
              onSubmit={sendPrompt}
              onHistoryAppend={appendHistory}
              onToggleToolDetails={() => dispatch({ type: "tool.details.toggled" })}
              onTogglePlanMode={togglePlanMode}
              onPreviewCommand={previewSlashCommand}
              onExit={() => {
                void closeAndExit();
              }}
            />
          </Box>
        )}
        {filteredSessionPicker ? null : (
          <Box flexShrink={0} width="100%">
            <StatusBar
              mode={previewMode ?? mode}
              cwd={state.cwd}
              modelLabel={state.modelLabel}
            />
          </Box>
        )}
      </Box>
    </Box>
  );

  async function handleSlashCommand(value: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const [command = "", ...args] = value.trim().split(/\s+/);

    if (command === "/" || command === "/help") {
      dispatch({ type: "system.message", content: formatSlashHelp() });
      return;
    }

    if (command === "/exit" || command === "/quit") {
      await closeAndExit();
      return;
    }

    if (command === "/clear") {
      dispatch({ type: "messages.cleared" });
      return;
    }

    if (command === "/context") {
      dispatch({ type: "system.message", content: formatProjectContext(runtime.commandRuntime.projectContext) });
      return;
    }

    if (command === "/sessions") {
      const summaries = await listSessionSummaries(runtime.commandRuntime.workspaceRoot);
      dispatch({ type: "system.message", content: formatSessionSummaries(summaries) });
      return;
    }

    if (command === "/resume") {
      const session = args[0];
      if (!session) {
        const summaries = await listSessionSummaries(runtime.commandRuntime.workspaceRoot);
        setSessionPicker({ sessions: summaries.filter((summary) => summary.firstUserMessage.trim()).slice().reverse(), selectedIndex: 0, query: "" });
        return;
      }
      await resumeSessionById(session);
      return;
    }

    if (command === "/plan") {
      const task = args.join(" ").trim();
      if (!task) {
        dispatch({ type: "system.message", content: "Usage: /plan <task>" });
        return;
      }
      setMode("plan");
      await createTuiPlan(task);
      return;
    }

    dispatch({ type: "system.message", content: `Unknown command: ${command}\n\n${formatSlashHelp()}` });
  }

  async function closeAndExit(): Promise<void> {
    if (exitingRef.current) return;
    exitingRef.current = true;
    const runtime = runtimeRef.current;
    if (runtime) {
      onExitSummary?.({
        sessionId: runtime.commandRuntime.recorder.sessionId,
        sessionFile: runtime.commandRuntime.recorder.filePath
      });
      await runtime.close();
    }
    app.exit();
  }

  async function createTuiPlan(task: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    runtime.commandRuntime.recorder.record({ type: "user_message", content: `plan: ${task}` });
    dispatch({ type: "user.message", content: `/plan ${task}` });

    try {
      const messages = [
        {
          role: "system" as const,
          content: buildSystemPrompt("plan")
        },
        {
          role: "user" as const,
          content: `${formatProjectContext(runtime.commandRuntime.projectContext)}\n\nTask:\n${task}`
        }
      ];
      const answer = runtime.commandRuntime.llm.streamChat
        ? await runtime.commandRuntime.llm.streamChat(messages, (delta) => {
          dispatch({ type: "assistant.delta", content: delta });
        })
        : await runtime.commandRuntime.llm.chat(messages);

      runtime.commandRuntime.recorder.record({ type: "assistant_message", content: answer });
      dispatch({ type: "assistant.completed", content: answer });
      dispatch({ type: "session.completed", sessionId: runtime.commandRuntime.recorder.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.commandRuntime.recorder.record({ type: "error", message });
      dispatch({ type: "session.error", sessionId: runtime.commandRuntime.recorder.sessionId, message });
    }
  }

  async function resumeSessionById(session: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const filePath = await resolveSessionFile(runtime.commandRuntime.workspaceRoot, session);
    await runtime.resumeSession(filePath);
    const events = await readSessionEvents(filePath);
    dispatch({
      type: "messages.replaced",
      viewingSessionId: sessionIdFromFile(filePath),
      messages: sessionEventsToMessages(runtime.commandRuntime.workspaceRoot, filePath, events)
    });
    setMode("chat");
  }
}

function splitTranscript(messages: Array<{ id: string; role: "user" | "assistant" | "system" | "error"; content: string }>, status: string): {
  staticMessages: Array<{ id: string; role: "user" | "assistant" | "system" | "error"; content: string }>;
  liveMessages: Array<{ id: string; role: "user" | "assistant" | "system" | "error"; content: string }>;
} {
  const last = messages[messages.length - 1];
  const hasLiveAssistant = last?.role === "assistant" && (status === "thinking" || status === "running" || status === "waiting_permission");
  if (!hasLiveAssistant) return { staticMessages: messages, liveMessages: [] };
  return { staticMessages: messages.slice(0, -1), liveMessages: [last] };
}

function shouldShowSeparator(messages: Array<{ role: "user" | "assistant" | "system" | "error" }>, index: number): boolean {
  const message = messages[index];
  if (message?.role !== "user") return false;
  return messages.slice(0, index).some((item) => item.role === "user" || item.role === "assistant");
}

function StaticTranscriptItem({
  message,
  showSeparator
}: {
  message: { id: string; role: "user" | "assistant" | "system" | "error"; content: string };
  showSeparator: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {showSeparator ? <Text color="gray">────────────────────────────────────────────────────────────────</Text> : null}
      <MessageItem message={message} />
    </Box>
  );
}

function isKnownSlashCommand(value: string): boolean {
  const [command = ""] = value.trim().split(/\s+/);
  return command === "/" || TUI_SLASH_COMMANDS.some((item) => item.name === command);
}

function formatModelLabel(provider: string, model: string): string {
  if (!model || model === provider) return provider;
  return `${provider}/${model}`;
}

function formatSlashHelp(): string {
  return [
    "Commands:",
    "/help /clear /context /sessions /resume [session]",
    "/plan <task> /exit /quit"
  ].join("\n");
}

function formatSessionSummaries(summaries: SessionSummary[]): string {
  if (!summaries.length) return "No sessions found.";
  const latest = summaries.slice(-12).reverse();
  return [
    "Recent sessions:",
    ...latest.map((summary) => {
      const id = summary.fileName.replace(/\.jsonl$/, "");
      const first = summary.firstUserMessage.replace(/\s+/g, " ").slice(0, 64) || "(no user message)";
      const last = summary.lastAssistantMessage.replace(/\s+/g, " ").slice(0, 64) || "(no assistant message)";
      return [
        `${id} | ${formatAbsoluteTime(summary.createdAt)} | ${relativeTime(summary.updatedAt)} | ${String(summary.eventCount)} events`,
        `  user: ${first}`,
        `  biny: ${last}`
      ].join("\n");
    })
  ].join("\n");
}

function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter((session) => [
    session.fileName,
    session.firstUserMessage,
    session.lastAssistantMessage
  ].some((value) => value.toLowerCase().includes(normalized)));
}

function formatAbsoluteTime(value: string): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
