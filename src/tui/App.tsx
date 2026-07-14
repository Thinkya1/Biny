/**
 * TUI 顶层应用模块。
 *
 * 这个组件把 Ink 界面、TUI runtime、reducer、输入框、权限提示、会话选择器和 transcript 展示串在一起。
 * 它负责处理全局快捷键、slash command、plan 模式、session 恢复和退出摘要，但不直接执行工具。
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { parseThinkingSelection, type ModelChoice, type ThinkingSelection } from "../llm/ModelManager.js";
import type { SessionSummary } from "../session/events.js";
import { formatPermissionModeChanged } from "../permission/commands.js";
import { createInitialTuiState, tuiReducer } from "./state.js";
import { Header } from "./components/Header.js";
import { Welcome } from "./components/Welcome.js";
import { Transcript } from "./components/Transcript.js";
import { InputBox } from "./components/InputBox.js";
import { StatusBar } from "./components/StatusBar.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PermissionModePicker } from "./components/PermissionModePicker.js";
import { SessionPicker, sessionPickerPageSize } from "./components/SessionPicker.js";
import { TranscriptViewer } from "./components/TranscriptViewer.js";
import { HelpDialog } from "./components/HelpDialog.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { createTuiRuntime, type TuiRuntime } from "./runtime/createTuiRuntime.js";
import type { PermissionChoice } from "./types.js";
import { TUI_SLASH_COMMANDS } from "./slashCommands.js";
import { sessionEventsToTranscript } from "./sessionTranscript.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
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
  const [modelPicker, setModelPicker] = useState<{
    models: ModelChoice[];
    currentAlias: string;
    currentThinking: ThinkingSelection;
  } | undefined>(undefined);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [transcriptViewer, setTranscriptViewer] = useState<ExpandableTranscript | undefined>(undefined);
  const [helpDialog, setHelpDialog] = useState<{ message?: string } | undefined>(undefined);
  const [contextUsage, setContextUsage] = useState<{ usedTokens?: number; maxTokens?: number; source?: "estimated" | "provider" }>({});
  const runtimeRef = useRef<TuiRuntime | undefined>(undefined);
  const exitingRef = useRef(false);
  const app = useApp();
  const { columns, rows } = useWindowSize();

  const refreshContextUsage = useCallback(async (runtime = runtimeRef.current): Promise<void> => {
    if (!runtime) return;
    try {
      const context = await runtime.contextStatus();
      setContextUsage({ usedTokens: context.budget.usedTokens, maxTokens: context.budget.maxTokens, source: context.budget.source });
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }, []);

  useEffect(() => {
    // TUI runtime 异步创建；组件卸载时关闭 recorder，避免 session 文件未 flush。
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void createTuiRuntime(workspaceRoot)
      .then((runtime) => {
        if (disposed) {
          void runtime.close();
          return;
        }
        runtimeRef.current = runtime;
        const info = runtime.getInfo();
        setPermissionMode(runtime.getPermissionMode());
        // 输入历史失败不阻断 TUI，只作为 system message 显示。
        void loadInputHistory(info.workspaceRoot)
          .then(setInputHistory)
          .catch((error) => {
            dispatch({ type: "system.message", content: `读取输入历史失败：${error instanceof Error ? error.message : String(error)}` });
          });
        unsubscribe = runtime.subscribe((event) => {
          dispatch(event);
          if (event.type === "session.completed" || event.type === "session.error") {
            void refreshContextUsage(runtime);
          }
        });
        dispatch({
          type: "session.started",
          sessionId: info.sessionId,
          sessionFile: info.sessionFile,
          cwd: info.workspaceRoot,
          provider: info.provider,
          modelLabel: info.modelLabel,
          reasoningLabel: info.reasoningLabel
        });
        void refreshContextUsage(runtime);
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      unsubscribe?.();
      void runtimeRef.current?.close();
    };
  }, [refreshContextUsage, workspaceRoot]);

  useInput((input, key) => {
    // App 级快捷键只处理全局动作：详情、取消和退出。
    const isBusy = state.status === "thinking" || state.status === "running" || state.status === "waiting_permission";
    if (modelPicker && !(key.ctrl && input === "c")) return;
    if (key.ctrl && input.toLowerCase() === "o") {
      const expandable = latestExpandableTranscript(state.transcript);
      if (expandable) setTranscriptViewer(expandable);
      return;
    }
    if (key.ctrl && input.toLowerCase() === "t") {
      const expandable = latestExpandableTranscript(state.transcript);
      if (expandable) setTranscriptViewer(expandable);
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
    if (value.trim().startsWith("/")) {
      void handleSlashCommand(value).catch((error) => {
        setTranscriptViewer({ title: "Command Error", content: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (mode === "plan") {
      const runtime = runtimeRef.current;
      if (runtime) void runtime.sendPrompt(value, "plan").finally(() => refreshContextUsage(runtime));
      return;
    }
    const runtime = runtimeRef.current;
    if (runtime) void runtime.sendPrompt(value, mode).finally(() => refreshContextUsage(runtime));
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
  const hasToolCalls = [...state.transcript.committed, ...state.transcript.active].some((item) => item.kind === "tool");
  const overlayOpen = Boolean(filteredSessionPicker || transcriptViewer || helpDialog || modelPicker || permissionModePicker);
  const isWelcomeVisible = !overlayOpen && !state.permission && state.transcript.committed.length === 0 && state.transcript.active.length === 0;
  const mainWidth = Math.max(1, columns);
  const mainHeight = Math.max(1, rows - 5);

  const togglePlanMode = (): void => {
    // Plan mode 是会话级 UI 模式；当前提示词和只读工具集由 runtime 按 mode 装配。
    setPreviewMode(undefined);
    setMode((current) => current === "plan" ? "chat" : "plan");
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
      <Header sessionId={state.sessionId} viewingSessionId={state.viewingSessionId} cwd={state.cwd} />
      <Box flexDirection="column" width="100%">
        {transcriptViewer ? (
          <TranscriptViewer
            transcript={transcriptViewer}
            width={mainWidth}
            height={mainHeight}
            onExit={() => setTranscriptViewer(undefined)}
          />
        ) : helpDialog ? (
          <HelpDialog
            commands={TUI_SLASH_COMMANDS}
            message={helpDialog.message}
            onExit={() => setHelpDialog(undefined)}
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
            onPageMove={(direction) => setSessionPicker((current) => {
              if (!current) return current;
              const sessions = filterSessions(current.sessions, current.query);
              if (!sessions.length) return { ...current, selectedIndex: 0 };
              return {
                ...current,
                selectedIndex: Math.min(
                  Math.max(current.selectedIndex + direction * sessionPickerPageSize, 0),
                  sessions.length - 1
                )
              };
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
        ) : modelPicker ? (
          <ModelPicker
            models={modelPicker.models}
            currentAlias={modelPicker.currentAlias}
            currentThinking={modelPicker.currentThinking}
            onSelect={(selection) => {
              void applyModelSelection(selection);
            }}
            onCancel={() => setModelPicker(undefined)}
          />
        ) : permissionModePicker ? (
          <PermissionModePicker
            currentMode={permissionMode}
            onSelect={(nextMode) => {
              void applyPermissionMode(nextMode);
            }}
            onCancel={() => setPermissionModePicker(false)}
          />
        ) : state.permission ? (
          <PermissionPrompt
            request={state.permission}
            detailsExpanded={state.permissionDetailsExpanded}
            onAnswer={answerPermission}
            onToggleDetails={() => dispatch({ type: "permission.details.toggled" })}
          />
        ) : isWelcomeVisible ? (
          <Welcome cwd={state.cwd} />
        ) : (
          <Transcript
            transcript={state.transcript}
            width={mainWidth}
          />
        )}
      </Box>
      <Box flexShrink={0} width="100%">
        <InputBox
          disabled={state.status === "waiting_permission" || permissionModePicker || overlayOpen}
          disabledPlaceholder={permissionModePicker ? "choose a permission mode" : overlayOpen ? "close overlay to continue" : undefined}
          busy={state.status === "thinking" || state.status === "running"}
          hasToolCalls={hasToolCalls}
          slashCommands={TUI_SLASH_COMMANDS}
          initialHistory={inputHistory}
          onSubmit={sendPrompt}
          onHistoryAppend={appendHistory}
          onToggleToolDetails={() => {
            const expandable = latestExpandableTranscript(state.transcript);
            if (expandable) setTranscriptViewer(expandable);
          }}
          onTogglePlanMode={togglePlanMode}
          onPreviewCommand={previewSlashCommand}
          onExit={() => {
            void closeAndExit();
          }}
        />
      </Box>
      <StatusBar
        modelLabel={state.modelLabel}
        contextUsedTokens={contextUsage.usedTokens}
        contextMaxTokens={contextUsage.maxTokens}
        contextSource={contextUsage.source}
        status={state.status}
        mode={previewMode ?? mode}
        width={columns}
      />
    </Box>
  );

  async function handleSlashCommand(value: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // slash command 在 TUI 内部执行，不进入 agent intent 识别。
    const [command = "", ...args] = value.trim().split(/\s+/);

    if (command === "/" || command === "/help") {
      setHelpDialog({});
      return;
    }

    if (command === "/exit" || command === "/quit") {
      await closeAndExit();
      return;
    }

    if (command === "/clear") {
      dispatch({ type: "transcript.cleared" });
      return;
    }

    if (command === "/context") {
      const report = await runtime.contextReport();
      setTranscriptViewer({ title: "Context", content: report.startsWith("Context\n") ? report.slice("Context\n".length) : report });
      await refreshContextUsage(runtime);
      return;
    }

    if (command === "/usage") {
      setTranscriptViewer({ title: "Usage", content: runtime.usageReport().replace(/^Usage\n\n?/, "") });
      return;
    }

    if (command === "/status") {
      const info = runtime.getInfo();
      setTranscriptViewer({
        title: "Status",
        content: [
          `Model: ${info.modelLabel}`,
          `Reasoning: ${info.reasoningLabel}`,
          `Permissions: ${runtime.getPermissionMode()}`,
          "",
          runtime.extensionReport()
        ].join("\n")
      });
      return;
    }

    if (command === "/mcp" || command === "/skills" || command === "/plugins") {
      const section = command.slice(1) as "mcp" | "skills" | "plugins";
      const title = section === "mcp" ? "MCP" : section.charAt(0).toUpperCase() + section.slice(1);
      setTranscriptViewer({ title, content: runtime.extensionReport(section).replace(new RegExp(`^${title}\\n`), "") });
      return;
    }

    if (command === "/subagent") {
      const task = args.join(" ").trim();
      if (!task) {
        setTranscriptViewer({ title: "Subagent", content: "Usage: /subagent <read-only task>" });
        return;
      }
      const output = await runtime.runSubagentTask(task);
      setTranscriptViewer({ title: "Subagent", content: output || "Subagent returned no text." });
      return;
    }

    if (command === "/review") {
      const instructions = args.join(" ").trim();
      const task = instructions || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
      const output = await runtime.runSubagentTask(task);
      setTranscriptViewer({ title: "Code Review", content: output || "No review findings." });
      return;
    }

    if (command === "/compact") {
      setTranscriptViewer({ title: "Compact", content: await runtime.compactConversation(args.join(" ").trim() || undefined) });
      await refreshContextUsage(runtime);
      return;
    }

    if (command === "/model") {
      if (!args[0]) {
        const info = runtime.getInfo();
        setModelPicker({
          models: runtime.listModels(),
          currentAlias: info.modelAlias,
          currentThinking: info.thinking
        });
        return;
      }
      await applyModelSelection({ alias: args[0], thinking: parseThinkingSelection(args[1]) });
      return;
    }

    if (command === "/sessions") {
      const summaries = await runtime.listSessions();
      setSessionPicker({ sessions: summaries.filter((summary) => summary.firstUserMessage.trim()).slice().reverse(), selectedIndex: 0, query: "" });
      return;
    }

    if (command === "/permissions" || command === "/approvals") {
      if (args.length === 0) {
        setPermissionMode(runtime.getPermissionMode());
        setPermissionModePicker(true);
        return;
      }
      setTranscriptViewer({ title: "Permissions", content: await runtime.runPermissionCommand(args) });
      setPermissionMode(runtime.getPermissionMode());
      return;
    }

    if (command === "/resume") {
      const session = args[0];
      if (!session) {
        // 无参数 /resume 打开选择器；有参数时直接恢复指定 session。
        const summaries = await runtime.listSessions();
        setSessionPicker({ sessions: summaries.filter((summary) => summary.firstUserMessage.trim()).slice().reverse(), selectedIndex: 0, query: "" });
        return;
      }
      await resumeSessionById(session);
      return;
    }

    if (command === "/plan") {
      const task = args.join(" ").trim();
      if (!task) {
        togglePlanMode();
        return;
      }
      setMode("plan");
      await runtime.sendPrompt(task, "plan");
      await refreshContextUsage(runtime);
      return;
    }

    setHelpDialog({ message: `Unknown command: ${command}` });
  }

  async function closeAndExit(): Promise<void> {
    // closeAndExit 幂等，防止 Ctrl+C 和组件 unmount 同时触发重复关闭。
    if (exitingRef.current) return;
    exitingRef.current = true;
    const runtime = runtimeRef.current;
    if (runtime) {
      const info = runtime.getInfo();
      onExitSummary?.({
        sessionId: info.sessionId,
        sessionFile: info.sessionFile
      });
      await runtime.close();
    }
    app.exit();
  }

  async function applyPermissionMode(nextMode: PermissionMode): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.setPermissionMode(nextMode);
    setPermissionMode(nextMode);
    setPermissionModePicker(false);
    dispatch({ type: "system.message", content: formatPermissionModeChanged(nextMode) });
  }

  async function applyModelSelection(selection: { alias: string; thinking?: ThinkingSelection }): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const info = await runtime.switchModel(selection.alias, selection.thinking);
      setModelPicker(undefined);
      dispatch({ type: "system.message", content: `Model changed to ${info.modelLabel} ${info.reasoningLabel.toLowerCase()}` });
    } catch (error) {
      setModelPicker(undefined);
      setTranscriptViewer({ title: "Model", content: `Model switch failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function resumeSessionById(session: string): Promise<void> {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // runtime 同时恢复 session recorder 和模型可用的 conversation，再把同一份事件转成展示消息。
    const resumed = await runtime.resumeSession(session);
    dispatch({
      type: "transcript.replaced",
      viewingSessionId: resumed.sessionId,
      items: sessionEventsToTranscript(resumed.events)
    });
    await refreshContextUsage(runtime);
    setMode("chat");
  }
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
