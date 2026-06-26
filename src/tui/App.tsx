/**
 * TUI 顶层应用模块。
 *
 * 这个组件把 Ink 界面、TUI runtime、reducer、输入框、权限提示、会话选择器和 transcript 展示串在一起。
 * 它负责处理全局快捷键、slash command、plan 模式、session 恢复和退出摘要，但不直接执行工具。
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { saveConfig } from "../config/loader.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { listSessionSummaries, readSessionEvents, type SessionSummary } from "../session/events.js";
import { resolveSessionFile } from "../session/store.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { formatProjectContext } from "../project/ProjectContext.js";
import { formatPermissionModeChanged, runPermissionCommand } from "../permission/commands.js";
import { createInitialTuiState, tuiReducer } from "./state.js";
import { Header } from "./components/Header.js";
import { MessageList } from "./components/MessageList.js";
import { InputBox } from "./components/InputBox.js";
import { StatusBar } from "./components/StatusBar.js";
import { TurnStatus } from "./components/TurnStatus.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PermissionModePicker } from "./components/PermissionModePicker.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { TranscriptViewer } from "./components/TranscriptViewer.js";
import { createTuiRuntime, type TuiRuntime } from "./runtime/createTuiRuntime.js";
import type { PermissionChoice } from "./types.js";
import { TUI_SLASH_COMMANDS } from "./slashCommands.js";
import { sessionEventsToMessages, sessionIdFromFile } from "./sessionTranscript.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
import { resizableTranscriptMessages } from "./transcriptSplit.js";
import { latestExpandableTranscript, type ExpandableTranscript } from "./transcriptViewer.js";
import { tuiColors } from "./theme/index.js";

export interface AppProps {
  workspaceRoot: string;
  onExitSummary?: (summary: TuiExitSummary) => void;
}

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

export function App({ workspaceRoot, onExitSummary }: AppProps): React.ReactElement {
  // App 负责把 runtime、reducer、输入框、session picker 和各展示组件串起来。
  const [state, dispatch] = useReducer(tuiReducer, workspaceRoot, createInitialTuiState);
  const [startupError, setStartupError] = useState<string | undefined>(undefined);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<"chat" | "plan">("chat");
  const [previewMode, setPreviewMode] = useState<"chat" | "plan" | undefined>(undefined);
  const [sessionPicker, setSessionPicker] = useState<{ sessions: SessionSummary[]; selectedIndex: number; query: string } | undefined>(undefined);
  const [permissionModePicker, setPermissionModePicker] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [transcriptViewer, setTranscriptViewer] = useState<ExpandableTranscript | undefined>(undefined);
  const runtimeRef = useRef<TuiRuntime | undefined>(undefined);
  const exitingRef = useRef(false);
  const app = useApp();
  const { rows } = useWindowSize();

  useEffect(() => {
    // TUI runtime 异步创建；组件卸载时关闭 recorder，避免 session 文件未 flush。
    let disposed = false;
    void createTuiRuntime(workspaceRoot)
      .then((runtime) => {
        if (disposed) {
          void runtime.close();
          return;
        }
        runtimeRef.current = runtime;
        setPermissionMode(runtime.commandRuntime.permissionManager.getStatus().mode);
        // 输入历史失败不阻断 TUI，只作为 system message 显示。
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
    // App 级快捷键只处理全局动作：滚动、详情、取消和退出。
    const isBusy = state.status === "thinking" || state.status === "running" || state.status === "waiting_permission";
    if (key.ctrl && input.toLowerCase() === "o") {
      dispatch({ type: "tool.details.toggled" });
      return;
    }
    if (key.ctrl && input.toLowerCase() === "t") {
      const expandable = latestExpandableTranscript(state.messages);
      if (expandable) setTranscriptViewer(expandable);
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
    if (key.escape && transcriptViewer) {
      setTranscriptViewer(undefined);
      return;
    }
    if (key.escape && permissionModePicker) {
      setPermissionModePicker(false);
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
    // 输入提交后按 slash、plan mode、chat mode 三条路径分发。
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
    // 历史先更新内存，磁盘写入失败只提示，不回滚当前 UI。
    setInputHistory((current) => [...current, value].slice(-100));
    void appendInputHistory(workspaceRoot, value).catch((error) => {
      dispatch({ type: "system.message", content: `写入输入历史失败：${error instanceof Error ? error.message : String(error)}` });
    });
  };

  const answerPermission = (choice: PermissionChoice): void => {
    // 权限答案交给 TuiRuntime，由它恢复挂起的 agent loop。
    runtimeRef.current?.answerPermission(choice);
  };

  // session picker 在原始 session 列表上做即时过滤，不改变源列表。
  const filteredSessionPicker = sessionPicker
    ? {
      ...sessionPicker,
      sessions: filterSessions(sessionPicker.sessions, sessionPicker.query)
    }
    : undefined;
  const transcriptMessages = resizableTranscriptMessages(state.messages);

  const togglePlanMode = (): void => {
    // 手动切换 plan mode 会追加一条 system message，方便 transcript 留痕。
    setPreviewMode(undefined);
    setMode((current) => {
      const next = current === "plan" ? "chat" : "plan";
      dispatch({ type: "system.message", content: next === "plan" ? "已进入 Plan 模式：后续输入只生成计划，不执行工具或修改文件。" : "已回到 Chat 模式。" });
      return next;
    });
  };

  const previewSlashCommand = useCallback((commandName: string | undefined): void => {
    // slash 菜单选中 /plan 时提前把状态栏切到 plan 预览。
    setPreviewMode(commandName === "/plan" ? "plan" : undefined);
  }, []);

  if (startupError) {
    return (
      <Box flexDirection="column">
        <Text color={tuiColors.error}>TUI startup failed: {startupError}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" flexShrink={0} width="100%">
        <Box flexShrink={0} width="100%">
          <Header sessionId={state.sessionId} viewingSessionId={state.viewingSessionId} />
        </Box>
        <Box flexDirection="column">
          {transcriptViewer ? (
          <TranscriptViewer
            transcript={transcriptViewer}
            onExit={() => setTranscriptViewer(undefined)}
          />
        ) : filteredSessionPicker ? (
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
            messages={transcriptMessages}
            visibleCount={Math.max(1, rows - 12)}
            scrollOffset={state.messageScrollOffset}
            followLatest={state.followLatest}
          />
        )}
        {transcriptViewer ? null : (
        <PermissionPrompt
          request={state.permission}
          detailsExpanded={state.permissionDetailsExpanded}
          onAnswer={answerPermission}
          onToggleDetails={() => dispatch({ type: "permission.details.toggled" })}
        />
        )}
        {permissionModePicker ? (
          <PermissionModePicker
            currentMode={permissionMode}
            onSelect={(nextMode) => {
              void applyPermissionMode(nextMode);
            }}
            onCancel={() => setPermissionModePicker(false)}
          />
        ) : null}
        {filteredSessionPicker || transcriptViewer ? null : (
          <TurnStatus status={state.status} turnStartedAt={state.turnStartedAt} lastWorkedMs={state.lastWorkedMs} />
        )}
        </Box>
        {filteredSessionPicker || transcriptViewer ? null : (
          <Box flexShrink={0} width="100%">
            <InputBox
              disabled={state.status === "waiting_permission" || permissionModePicker || transcriptViewer !== undefined}
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
        {filteredSessionPicker || transcriptViewer ? null : (
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
    // slash command 在 TUI 内部执行，不进入 agent intent 识别。
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

    if (command === "/permissions" || command === "/approvals") {
      if (args.length === 0) {
        setPermissionMode(runtime.commandRuntime.permissionManager.getStatus().mode);
        setPermissionModePicker(true);
        return;
      }
      dispatch({ type: "system.message", content: runPermissionCommand(runtime.commandRuntime.permissionManager, args) });
      await persistCurrentPermissionMode(runtime);
      return;
    }

    if (command === "/resume") {
      const session = args[0];
      if (!session) {
        // 无参数 /resume 打开选择器；有参数时直接恢复指定 session。
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
    // closeAndExit 幂等，防止 Ctrl+C 和组件 unmount 同时触发重复关闭。
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

    // TUI plan 只调用模型生成计划，不执行工具；仍然记录到当前 session。
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
          // plan 模式也复用 assistant.delta，以便 TUI 能流式显示计划内容。
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

  async function applyPermissionMode(nextMode: PermissionMode): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.commandRuntime.permissionManager.setMode(nextMode);
    runtime.commandRuntime.config.permission.mode = nextMode;
    await saveConfig(runtime.commandRuntime.workspaceRoot, runtime.commandRuntime.config);
    setPermissionMode(nextMode);
    setPermissionModePicker(false);
    dispatch({ type: "system.message", content: formatPermissionModeChanged(nextMode) });
  }

  async function persistCurrentPermissionMode(runtime: TuiRuntime): Promise<void> {
    const nextMode = runtime.commandRuntime.permissionManager.getStatus().mode;
    runtime.commandRuntime.config.permission.mode = nextMode;
    await saveConfig(runtime.commandRuntime.workspaceRoot, runtime.commandRuntime.config);
    setPermissionMode(nextMode);
  }

  async function resumeSessionById(session: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // 恢复后先切换 recorder，再把历史事件转换为可展示消息。
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

function isKnownSlashCommand(value: string): boolean {
  // 只拦截已知 slash 命令；未知 /xxx 继续显示帮助，不交给 agent。
  const [command = ""] = value.trim().split(/\s+/);
  return command === "/" || TUI_SLASH_COMMANDS.some((item) => item.name === command);
}

function formatModelLabel(provider: string, model: string): string {
  // 状态栏模型名避免重复显示 mock/mock 这类冗余形式。
  if (!model || model === provider) return provider;
  return `${provider}/${model}`;
}

function formatSlashHelp(): string {
  // 帮助文本保持短小，详细交互提示由输入框和状态栏承担。
  return [
    "Commands:",
    "/help /clear /context /sessions /resume [session]",
    "/permissions [status|readonly|ask|auto|full|reset]",
    "/plan <task> /exit /quit"
  ].join("\n");
}

function formatSessionSummaries(summaries: SessionSummary[]): string {
  // 只展示最近 12 个 session，完整列表可通过选择器继续过滤。
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
  // 过滤同时匹配文件名、首条用户消息和最后 assistant 消息。
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter((session) => [
    session.fileName,
    session.firstUserMessage,
    session.lastAssistantMessage
  ].some((value) => value.toLowerCase().includes(normalized)));
}

function formatAbsoluteTime(value: string): string {
  // TUI 列表里只需要月日时分，年份可从 session 文件名或完整记录中查看。
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function relativeTime(value: string): string {
  // 相对时间用于快速判断最近更新，不参与 session 排序。
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
