import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { createInitialTuiState, tuiReducer } from "../src/tui/state.js";
import { agentEventToRuntimeEvents } from "../src/tui/runtime/agentEventAdapter.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";
import { diffLineStyle } from "../src/tui/diffLines.js";
import { foldableTranscriptItems, formatToolDuration, latestExpandableTranscript } from "../src/tui/transcriptText.js";
import { TranscriptView } from "../src/tui/components/transcriptView.js";
import { ThinkingComponent, ToolExecutionComponent, splitToolTitle } from "../src/tui/components/messages.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "../src/tui/components/dialogs.js";
import {
  FooterComponent,
  ShortcutsBarComponent,
  WelcomeComponent,
  footerLayout,
  formatTokens,
  shortSessionId,
  shortcutHints,
  statusMessage,
  visibleShortcutHints
} from "../src/tui/components/chrome.js";
import type { PermissionChoice, ToolTranscriptItem, TranscriptState, TuiPermissionRequest } from "../src/tui/types.js";
import {
  ansi256ToHex,
  availableThemes,
  getTheme,
  rgbToAnsi256,
  setTheme,
  theme,
  themeBgTokens,
  themeColorTokens
} from "../src/tui/theme/index.js";
import { CHAT_SLASH_COMMANDS } from "../src/cli/commands/chatSlash.js";
import { isConcurrentTuiSlashCommand, TUI_SLASH_COMMANDS } from "../src/tui/slashCommands.js";
import { modelThinkingOptions } from "../src/tui/modelOptions.js";
import {
  confirmedPermissionChoice,
  createPermissionPromptInteractionState,
  permissionPromptStateForRequest
} from "../src/tui/permissionOptions.js";
import { isFullYesConfirmation, permissionResultFromAnswer } from "../src/permission/confirmation.js";
import { permissionChoiceToResult } from "../src/tui/runtime/createTuiRuntime.js";
import type { SessionEvent } from "../src/session/recorder.js";

/** 去掉 ANSI，方便对渲染出来的行做文本断言。 */
function plain(line: string): string {
  return line.replace(/\u001B\[[0-9;]*m/g, "").replace(/\u001B_pi:c\u0007/g, "");
}

function plainLines(lines: string[]): string[] {
  return lines.map(plain);
}


/** 把一份 transcript 状态渲染成去掉 ANSI 的文本，便于断言。 */
function renderTranscript(transcript: TranscriptState, width: number): string {
  const view = new TranscriptView();
  view.sync(transcript);
  return renderView(view, width);
}

function renderView(view: TranscriptView, width: number): string {
  return plainLines(view.render(width)).join("\n");
}

async function main(): Promise<void> {
  testTranscriptUsesIndependentItemKinds();
  testRuntimeStatusEventsReachFooterState();
  testReasoningStreamingRendersContent();
  testIncompleteSessionStaysDistinctFromCompletion();
  testAbortedSessionStaysDistinctFromCompletion();
  testAssistantStreamingUpdatesOneActiveCell();
  testToolProgressUpdatesOneActiveCell();
  testToolDurationMeasuredInUi();
  testActiveToolShowsLatestOutput();
  testParallelToolsUpdateById();
  testDuplicateCompletionDoesNotFinishSiblingTool();
  testReusedToolCallIdKeepsUniqueTranscriptCells();
  testRecoverableErrorDoesNotFinalizeSiblingTools();
  testPermissionRejectionKeepsTurnRunning();
  testPermissionConfirmationContract();
  testLongCommandStaysInFoldedDetails();
  testCommandDisplayNeverLeaksRawCommand();
  testFailedCommandCommitsOneToolItem();
  testErrorFinalizesActiveCells();
  testSessionReplayUsesToolItems();
  testSessionReplayFinalizesPendingTools();
  testSlashCommandParity();
  await testSlashAutocompleteInsertsSingleSlash();
  testThemeTokensResolveToAnsi();
  testTranscriptViewSyncsIncrementally();
  testAssistantMarkdownRendersBlocks();
  testToolBlockRendersTitleAndClampedOutput();
  testThinkingBlockCollapses();
  testFooterAndChromeLayout();
  testStatusAndShortcutHints();
  testWelcomeRendersOnboarding();
  testModelThinkingOptionsUseModelCapabilities();
  testDialogsRenderAndHandleKeys();
  testPermissionDialogRequiresFullYes();
  testDiffStylesUseThemeTokens();
  testTranscriptTextHelpers();
}

function testModelThinkingOptionsUseModelCapabilities(): void {
  const proOptions = modelThinkingOptions({ efforts: ["low", "medium", "high"] });
  assert.deepEqual(proOptions.map((option) => option.value), ["low", "medium", "high"]);
  assert.equal(proOptions[1]?.label, "Medium");
  assert.deepEqual(modelThinkingOptions({ efforts: [] }), []);
}

function testPermissionConfirmationContract(): void {
  assert.equal(isFullYesConfirmation("yes"), true);
  assert.equal(isFullYesConfirmation(" YES "), true);
  assert.equal(isFullYesConfirmation("y"), false);
  assert.equal(isFullYesConfirmation(""), false);

  assert.deepEqual(permissionResultFromAnswer("", false), { approved: true, scope: "once" });
  assert.deepEqual(permissionResultFromAnswer("y", false), { approved: true, scope: "once" });
  assert.deepEqual(permissionResultFromAnswer("c", false), { approved: true, scope: "command" });
  assert.equal(permissionResultFromAnswer("", true).approved, false);
  assert.equal(permissionResultFromAnswer("y", true).approved, false);
  assert.equal(permissionResultFromAnswer("c", true).approved, false);
  assert.deepEqual(permissionResultFromAnswer("yes", true), { approved: true, scope: "once", confirmation: "yes" });
  assert.deepEqual(permissionResultFromAnswer("YES   COMMAND", true), { approved: true, scope: "command", confirmation: "yes" });
  assert.equal(permissionChoiceToResult("approve_once", false).confirmation, undefined);
  assert.equal(permissionChoiceToResult("approve_once", true).confirmation, "yes");
  assert.equal(permissionChoiceToResult("approve_command", true).confirmation, "yes");

  assert.equal(confirmedPermissionChoice(0, true, ""), undefined);
  assert.equal(confirmedPermissionChoice(0, true, "y"), undefined);
  assert.equal(confirmedPermissionChoice(0, true, "yes"), "approve_once");
  assert.equal(confirmedPermissionChoice(1, true, ""), "reject");
  assert.equal(confirmedPermissionChoice(2, true, "yes"), "approve_command");
  assert.equal(confirmedPermissionChoice(0, false, ""), "approve_once");

  const baseRequest = {
    tool: "run_command",
    title: "Command execution request",
    details: "sudo example",
    actionType: "shell",
    riskLevel: "critical",
    requireFullYes: true
  };
  const enteredState = {
    ...createPermissionPromptInteractionState(baseRequest),
    selectedIndex: 2,
    confirmation: "yes",
    confirmationAttempted: true
  };
  assert.equal(permissionPromptStateForRequest(enteredState, baseRequest), enteredState);
  assert.deepEqual(permissionPromptStateForRequest(enteredState, { ...baseRequest, title: "Next request" }), {
    request: { ...baseRequest, title: "Next request" },
    selectedIndex: 0,
    confirmation: "",
    confirmationAttempted: false
  });

}

function testSlashCommandParity(): void {
  assert.deepEqual(
    CHAT_SLASH_COMMANDS.map((command) => command.name),
    TUI_SLASH_COMMANDS.map((command) => command.name)
  );
  assert.equal(TUI_SLASH_COMMANDS.length, 23);
  assert.equal(TUI_SLASH_COMMANDS.find((command) => command.name === "/plan")?.requiresArgs, undefined);
  assert.ok(TUI_SLASH_COMMANDS.some((command) => command.name === "/memory"));
  assert.ok(TUI_SLASH_COMMANDS.some((command) => command.name === "/undo"));
  assert.ok(TUI_SLASH_COMMANDS.some((command) => command.name === "/continue"));
  assert.ok(TUI_SLASH_COMMANDS.some((command) => command.name === "/fork"));
  assert.equal(isConcurrentTuiSlashCommand("/subagent status"), true);
  assert.equal(isConcurrentTuiSlashCommand("/subagent CANCEL task-id"), true);
  assert.equal(isConcurrentTuiSlashCommand("/subagent agents"), true);
  assert.equal(isConcurrentTuiSlashCommand("/subagent review this"), false);
}

function testTranscriptUsesIndependentItemKinds(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "question" });
  state = tuiReducer(state, { type: "assistant.completed", content: "answer" });
  state = tuiReducer(state, { type: "system.message", content: "notification" });
  state = tuiReducer(state, { type: "session.error", message: "fatal" });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["user", "assistant", "notification", "error"]);

  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "read-1", tool: "read_file", args: { path: "README.md" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "read-1", tool: "read_file", result: { path: "README.md", content: "hello" } });
  assert.equal(state.transcript.committed.at(-1)?.kind, "tool");
}

function testRuntimeStatusEventsReachFooterState(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "runtime.status", status: "thinking" });
  assert.equal(state.status, "thinking");
  state = tuiReducer(state, { type: "runtime.status", status: "running" });
  assert.equal(state.status, "running");
  state = tuiReducer(state, { type: "runtime.queue.updated", queuedCount: 2 });
  assert.equal(state.queuedCount, 2);
  assert.deepEqual(agentEventToRuntimeEvents({
    type: "run.queued",
    sessionId: "session",
    runId: "run-2",
    timestamp: "2026-07-24T00:00:00.000Z",
    messageId: "message-2",
    input: "follow up",
    mode: "chat",
    position: 2,
    queueLength: 2
  }), [{ type: "runtime.queue.updated", queuedCount: 2 }]);
}

function testReasoningStreamingRendersContent(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "inspect" });
  state = tuiReducer(state, { type: "reasoning.delta", content: "先检查" });
  state = tuiReducer(state, { type: "reasoning.delta", content: "入口文件。" });
  assert.deepEqual(state.transcript.active.map((item) => item.kind), ["reasoning"]);
  assert.equal(state.transcript.active[0]?.content, "先检查入口文件。");

  state = tuiReducer(state, { type: "reasoning.completed", status: "分析完成" });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["user", "reasoning"]);
  assert.equal(state.transcript.committed[1]?.content, "先检查入口文件。");
  // Pi keeps completed thinking visible by default; Ctrl+E can still collapse it.
  const view = new TranscriptView();
  view.sync(state.transcript);
  const visibleThinking = renderView(view, 80);
  assert.match(visibleThinking, /先检查入口文件。/u);
  const reasoningId = state.transcript.committed[1]?.id;
  assert.ok(reasoningId);
  // 折叠后只剩标题行。
  const thinkingComponent = view.componentFor(reasoningId);
  assert.ok(thinkingComponent instanceof ThinkingComponent);
  thinkingComponent.setCollapsed(true);
  const collapsedThinking = renderView(view, 80);
  assert.match(collapsedThinking, /Thought/u);
  assert.doesNotMatch(collapsedThinking, /先检查入口文件。/u);

  const runtimeEvents = agentEventToRuntimeEvents({
    sessionId: "session",
    runId: "run",
    timestamp: "2026-07-24T00:00:00.000Z",
    type: "reasoning.delta",
    messageId: "message",
    content: "继续验证。"
  });
  assert.deepEqual(runtimeEvents, [{ type: "reasoning.delta", content: "继续验证。" }]);
}

function testIncompleteSessionStaysDistinctFromCompletion(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "finish the project" });
  state = tuiReducer(state, { type: "session.incomplete", sessionId: "session", message: "Step limit reached." });
  assert.equal(state.status, "incomplete");
  assert.equal(state.transcript.committed.at(-1)?.kind, "notification");
  assert.match(state.transcript.committed.at(-1)?.content ?? "", /Step limit/);
}

function testAbortedSessionStaysDistinctFromCompletion(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "run the project" });
  state = tuiReducer(state, { type: "session.aborted", sessionId: "session", message: "Current turn interrupted." });
  assert.equal(state.status, "aborted");
  assert.equal(state.transcript.committed.at(-1)?.kind, "notification");
  assert.match(state.transcript.committed.at(-1)?.content ?? "", /interrupted/i);
}

function testAssistantStreamingUpdatesOneActiveCell(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "stream" });
  const committedBefore = state.transcript.committed.length;
  state = tuiReducer(state, { type: "assistant.delta", content: "你" });
  const activeId = state.transcript.active[0]?.id;
  state = tuiReducer(state, { type: "assistant.delta", content: "好" });
  state = tuiReducer(state, { type: "assistant.delta", content: "！" });

  assert.equal(state.transcript.committed.length, committedBefore);
  assert.equal(state.transcript.active.length, 1);
  assert.equal(state.transcript.active[0]?.id, activeId);
  assert.deepEqual(state.transcript.active[0], { id: activeId, kind: "assistant", content: "你好！" });

  state = tuiReducer(state, { type: "assistant.completed", content: "你好！" });
  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.filter((item) => item.kind === "assistant").length, 1);
}

function testToolProgressUpdatesOneActiveCell(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "run-1", tool: "run_command", args: { command: "printf hello" } });
  state = tuiReducer(state, { type: "tool.call.progress", toolCallId: "run-1", tool: "run_command", update: { kind: "status", text: "Started: printf hello" } });
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, "Running…");
  state = tuiReducer(state, { type: "tool.call.progress", toolCallId: "run-1", tool: "run_command", update: { kind: "stdout", text: "hel" } });
  state = tuiReducer(state, { type: "tool.call.progress", toolCallId: "run-1", tool: "run_command", update: { kind: "stdout", text: "lo" } });

  assert.equal(state.transcript.committed.length, 0);
  assert.equal(state.transcript.active.length, 1);
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).output, "hello");

  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "run-1",
    tool: "run_command",
    result: { stdout: "hello", stderr: "", exitCode: 0, durationMs: 12 }
  });
  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.length, 1);
  assert.equal(state.transcript.committed[0]?.kind, "tool");
}

function testToolDurationMeasuredInUi(): void {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    let state = createInitialTuiState("/workspace");
    state = tuiReducer(state, { type: "tool.call.started", toolCallId: "timed", tool: "read_file", args: { path: "README.md" } });
    now = 2_450;
    state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "timed", tool: "read_file", result: { content: "done" } });
    assert.equal((state.transcript.committed[0] as ToolTranscriptItem).durationMs, 1_450);
  } finally {
    Date.now = originalNow;
  }
}

function testActiveToolShowsLatestOutput(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "streaming", tool: "run_command", args: { command: "long-running-command" } });
  state = tuiReducer(state, {
    type: "tool.call.progress",
    toolCallId: "streaming",
    tool: "run_command",
    update: { kind: "stdout", text: Array.from({ length: 8 }, (_, index) => `line ${String(index + 1)}`).join("\n") }
  });
  // 运行中的工具优先显示最新输出，最早的几行折叠掉。
  const output = renderTranscript(state.transcript, 80);
  assert.equal(output.includes("line 1\n"), false);
  assert.match(output, /line 8/u);
  assert.match(output, /earlier lines/u);
}

function testParallelToolsUpdateById(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "one", tool: "read_file", args: { path: "one.ts" } });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "two", tool: "read_file", args: { path: "two.ts" } });
  state = tuiReducer(state, { type: "tool.call.progress", toolCallId: "two", tool: "read_file", update: { kind: "progress", text: "second" } });
  assert.equal((state.transcript.active[1] as ToolTranscriptItem).progress, "second");
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, undefined);

  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "one", tool: "read_file", result: { path: "one.ts", content: "one" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "two", tool: "read_file", result: { path: "two.ts", content: "two" } });
  assert.deepEqual(state.transcript.committed.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["one", "two"]);
  assert.equal(new Set(state.transcript.committed.map((item) => item.id)).size, 2);
  assert.equal(state.transcript.active.length, 0);
}

function testDuplicateCompletionDoesNotFinishSiblingTool(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "one", tool: "read_file", args: { path: "one.ts" } });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "two", tool: "read_file", args: { path: "two.ts" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "one", tool: "read_file", result: { content: "one" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "one", tool: "read_file", result: { content: "duplicate" } });

  assert.deepEqual(state.transcript.committed.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["one"]);
  assert.deepEqual(state.transcript.active.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["two"]);
}

function testReusedToolCallIdKeepsUniqueTranscriptCells(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "tool-1-1", tool: "read_file", args: { path: "one.ts" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "tool-1-1", tool: "read_file", result: { content: "one" } });
  const firstId = state.transcript.committed[0]?.id;
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "tool-1-1", tool: "read_file", args: { path: "two.ts" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "tool-1-1", tool: "read_file", result: { content: "two" } });

  assert.equal(state.transcript.active.length, 0);
  assert.equal(state.transcript.committed.filter((item) => item.kind === "tool").length, 2);
  assert.notEqual(state.transcript.committed[1]?.id, firstId);
}

function testRecoverableErrorDoesNotFinalizeSiblingTools(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "failed", tool: "run_command", args: { command: "false" } });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "success", tool: "run_command", args: { command: "true" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "failed", tool: "run_command", result: { stderr: "failed", exitCode: 1 } });
  state = tuiReducer(state, { type: "error.message", message: "first command failed" });

  assert.deepEqual(state.transcript.active.map((item) => item.kind === "tool" ? item.toolCallId : undefined), ["success"]);
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "success", tool: "run_command", result: { stdout: "ok", exitCode: 0 } });
  const tools = state.transcript.committed.filter((item): item is ToolTranscriptItem => item.kind === "tool");
  assert.deepEqual(tools.map((item) => item.status), ["failed", "success"]);
  assert.equal(state.transcript.committed.some((item) => item.kind === "error"), true);
}

function testPermissionRejectionKeepsTurnRunning(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "user.message", content: "write it" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "write", tool: "write_file", args: { path: "x.ts" } });
  state = tuiReducer(state, {
    type: "permission.requested",
    tool: "write_file",
    title: "Write x.ts",
    details: "write",
    requireFullYes: false,
    actionType: "write",
    riskLevel: "write"
  });
  const turnStartedAt = state.turnStartedAt;
  state = tuiReducer(state, { type: "permission.rejected", tool: "write_file", reason: "Denied" });
  assert.equal(state.status, "running");
  assert.equal(state.turnStartedAt, turnStartedAt);
  assert.equal(state.transcript.active.length, 1);
}

function testLongCommandStaysInFoldedDetails(): void {
  const command = `node script.js ${"--very-long-option ".repeat(20)}`;
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "long-command",
    tool: "run_command",
    args: { command },
    display: { kind: "command", command }
  });
  const active = state.transcript.active[0] as ToolTranscriptItem;
  assert.equal(active.title, "Running command");
  assert.equal(active.title.includes(command), false);
  assert.match(active.details ?? "", /Command: node script\.js/);
  assert.match(active.details ?? "", /Exit code: running/);
  assert.deepEqual(latestExpandableTranscript(state.transcript), { title: "Running command", content: active.details });

  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "long-command",
    tool: "run_command",
    result: { stdout: "done", stderr: "", exitCode: 0, durationMs: 25 }
  });
  const tool = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(tool.title, "Ran command");
  assert.match(tool.details ?? "", /Command: node script\.js/);
  assert.match(tool.details ?? "", /Exit code: 0/);

  const view = new TranscriptView();
  view.sync(state.transcript);
  const collapsed = renderView(view, 40);
  assert.equal(collapsed.includes(command), false);
  assert.equal(collapsed.includes("Exit code"), false);
  const toolComponent = view.componentFor(tool.id);
  assert.ok(toolComponent instanceof ToolExecutionComponent);
  toolComponent.setExpanded(true);
  const expanded = renderView(view, 40);
  assert.equal(expanded.includes("Command: node script.js"), true);
  assert.equal(expanded.includes("Exit code: 0"), true);
}

function testCommandDisplayNeverLeaksRawCommand(): void {
  const command = "pnpm test --filter private-package-name";
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, {
    type: "tool.call.started",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    args: { script: command },
    description: `Run ${command}`,
    display: { kind: "command", command }
  });
  const active = state.transcript.active[0] as ToolTranscriptItem;
  assert.equal(active.title, "Running tests");
  assert.equal(active.title.includes(command), false);
  assert.match(active.details ?? "", /Command: pnpm test/);
  state = tuiReducer(state, {
    type: "tool.call.progress",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    update: { kind: "progress", text: `Executing ${command}` }
  });
  assert.equal((state.transcript.active[0] as ToolTranscriptItem).progress, "Running…");
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "plugin-command",
    tool: "plugin_shell",
    result: { stdout: "passed", exitCode: 0 }
  });
  const completed = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(completed.title, "Ran tests");
  assert.match(completed.details ?? "", /Exit code: 0/);
}

function testFailedCommandCommitsOneToolItem(): void {
  const command = "pnpm test --filter impossible";
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "failed", tool: "run_command", args: { command } });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "failed",
    tool: "run_command",
    result: { stdout: "partial output", stderr: "test suite failed", exitCode: 2, durationMs: 7 }
  });
  assert.equal(state.transcript.committed.length, 1);
  const tool = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(tool.status, "failed");
  assert.equal(tool.title, "Ran tests");
  const collapsed = renderTranscript(state.transcript, 80);
  assert.match(collapsed, /test suite failed/);
  assert.equal(collapsed.includes(command), false);
  assert.equal(collapsed.includes("Exit code: 2"), false);
  assert.match(tool.details ?? "", /Exit code: 2/);
  assert.match(tool.details ?? "", /partial output/);
}

function testErrorFinalizesActiveCells(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "assistant.delta", content: "partial" });
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "broken", tool: "run_command", args: { command: "bad-command" } });
  state = tuiReducer(state, { type: "session.error", message: "spawn failed" });
  assert.equal(state.transcript.active.length, 0);
  assert.deepEqual(state.transcript.committed.map((item) => item.kind), ["assistant", "tool", "error"]);
  const tool = state.transcript.committed[1] as ToolTranscriptItem;
  assert.equal(tool.status, "failed");
  assert.match(tool.details ?? "", /spawn failed/);
}

function testSessionReplayUsesToolItems(): void {
  const items = sessionEventsToTranscript([
    { type: "user_message", content: "read", time: "2026-07-12T00:00:00.000Z" },
    { type: "tool_call", toolCallId: "read-1", tool: "read_file", args: { path: "README.md" }, reasoningContent: "先读取 README。", time: "2026-07-12T00:00:01.000Z" },
    { type: "tool_result", toolCallId: "read-1", tool: "read_file", result: { path: "README.md", content: "line 1\nline 2" }, time: "2026-07-12T00:00:03.500Z" },
    { type: "assistant_message", content: "done" }
  ] as SessionEvent[]);
  assert.deepEqual(items.map((item) => item.kind), ["user", "reasoning", "tool", "assistant"]);
  assert.equal(items[1]?.content, "先读取 README。");
  const tool = items[2] as ToolTranscriptItem;
  assert.equal(tool.title, "Read README.md");
  assert.equal(tool.output, "line 1\nline 2");
  assert.equal(tool.durationMs, 2_500);
  assert.deepEqual(latestExpandableTranscript({ committed: items, active: [] }), { title: "Read README.md", content: tool.details });
}

function testSessionReplayFinalizesPendingTools(): void {
  const failed = sessionEventsToTranscript([
    { type: "tool_call", toolCallId: "failed", tool: "run_command", args: { command: "false" } },
    { type: "error", message: "process failed" }
  ] as SessionEvent[]);
  assert.deepEqual(failed.map((item) => item.kind), ["tool", "error"]);
  assert.equal((failed[0] as ToolTranscriptItem).status, "failed");

  const interrupted = sessionEventsToTranscript([
    { type: "tool_call", toolCallId: "pending", tool: "run_command", args: { command: "sleep 10" } }
  ] as SessionEvent[]);
  assert.equal((interrupted[0] as ToolTranscriptItem).status, "skipped");
  assert.equal((interrupted[0] as ToolTranscriptItem).title, "Interrupted command");
}

function testThemeTokensResolveToAnsi(): void {
  const tokens = [...themeColorTokens, ...themeBgTokens];
  for (const name of availableThemes()) {
    setTheme(name);
    for (const token of tokens) {
      assert.match(getTheme().color(token), /^#[0-9a-f]{6}$/, `${name} 主题缺少 token ${token}`);
    }
  }

  setTheme("dark");
  const dark = getTheme().color("accent");
  setTheme("light");
  assert.notEqual(getTheme().color("accent"), dark);
  setTheme("does-not-exist");
  assert.equal(getTheme().color("accent"), dark);

  // 前景只重置前景，保证嵌套加粗不会把颜色清掉。
  const nested = theme.fg("accent", `a${theme.bold("b")}c`);
  assert.match(nested, /\u001B\[39m$/u);
  assert.equal(plain(nested), "abc");
  assert.equal(plain(theme.bg("userMessageBg", "x")), "x");

  // 思考等级越高边框越亮，未知等级退回 off。
  assert.equal(plain(theme.thinkingBorder("max")("│")), "│");
  assert.notEqual(theme.thinkingBorder("max")("│"), theme.thinkingBorder("off")("│"));
  assert.equal(theme.thinkingBorder(undefined)("│"), theme.thinkingBorder("off")("│"));

  assert.equal(ansi256ToHex(196), "#ff0000");
  assert.equal(ansi256ToHex(240), "#585858");
  assert.equal(rgbToAnsi256(255, 0, 0), 196);
}

function testTranscriptViewSyncsIncrementally(): void {
  setTheme("dark");
  const view = new TranscriptView();
  const user = { id: "u1", kind: "user" as const, content: "请分析 `src/`" };
  const assistant = { id: "a1", kind: "assistant" as const, content: "## 结论\n\n- 一\n- 二" };

  assert.equal(view.sync({ committed: [user], active: [] }), true);
  const first = view.componentFor("u1");
  assert.notEqual(first, undefined);

  // 同一批条目再同步一次不应重建组件，也不应报告变化。
  assert.equal(view.sync({ committed: [user], active: [] }), false);
  assert.equal(view.componentFor("u1"), first);

  assert.equal(view.sync({ committed: [user], active: [assistant] }), true);
  const lines = plainLines(view.render(40));
  assert.match(lines.join("\n"), /请分析 src\//u);
  assert.match(lines.join("\n"), /结论/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, line);

  // 条目消失后组件要被回收。
  assert.equal(view.sync({ committed: [user], active: [] }), true);
  assert.equal(view.componentFor("a1"), undefined);
}

function testAssistantMarkdownRendersBlocks(): void {
  setTheme("dark");
  const view = new TranscriptView();
  view.sync({
    committed: [{
      id: "a1",
      kind: "assistant" as const,
      content: "## 标题\n\n| 模式 | 数 |\n|---|---|\n| apiKey | 0 |\n\n```ts\nconst a = 1;\n```\n\n> 结论"
    }],
    active: []
  });
  const lines = plainLines(view.render(44));
  const output = lines.join("\n");
  // 表格走框架的 Markdown 渲染：画成表格框，源码里的分隔行不再原样出现。
  assert.match(output, /┌.*┬.*┐/u);
  assert.match(output, /│ 模式\s+│ 数 │/u);
  assert.equal(output.includes("|---|"), false);
  // 代码块保留围栏标记并缩进内容。
  assert.match(output, /```ts/u);
  assert.match(output, /^ {3}const a = 1;/mu);
  assert.match(output, /结论/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 44, true, line);
}

function testToolBlockRendersTitleAndClampedOutput(): void {
  setTheme("dark");
  const item: ToolTranscriptItem = {
    id: "t1",
    kind: "tool",
    tool: "run_command",
    title: "Ran tests",
    argsSummary: "pnpm test",
    status: "success",
    output: "line one\nline two\nline three\nline four\nline five\nline six",
    details: "Command: pnpm test\nExit code: 0",
    durationMs: 1234
  };
  const component = new ToolExecutionComponent(item);
  const lines = plainLines(component.render(40));
  const text = lines.join("\n");
  assert.match(text, /✓ Ran tests\s+1\.2s/u);
  assert.match(text, /line one/u);
  // 默认只显示前四行，其余折叠成一行提示。
  assert.match(text, /… 2 more lines/u);
  assert.equal(text.includes("line six"), false);
  for (const line of lines) assert.equal(visibleWidth(line) <= 40, true, line);

  component.setExpanded(true);
  assert.match(plainLines(component.render(40)).join("\n"), /Exit code: 0/u);

  assert.deepEqual(splitToolTitle("Ran tests"), { verb: "Ran", rest: " tests" });
  assert.deepEqual(splitToolTitle("Ran"), { verb: "Ran", rest: "" });
}

function testThinkingBlockCollapses(): void {
  setTheme("dark");
  const component = new ThinkingComponent(
    { id: "r1", kind: "reasoning", content: "先看 transcript 的结构。", durationMs: 2300 },
    false
  );
  assert.match(plainLines(component.render(40)).join("\n"), /先看 transcript 的结构。/u);
  assert.match(plainLines(component.render(40)).join("\n"), /Thought for 2\.3s/u);

  component.setCollapsed(true);
  const collapsed = plainLines(component.render(40)).join("\n");
  assert.match(collapsed, /▸ Thought for 2\.3s/u);
  assert.equal(collapsed.includes("先看 transcript 的结构。"), false);
}

function testFooterAndChromeLayout(): void {
  setTheme("dark");
  const data = {
    cwd: "/tmp/workspace",
    sessionId: "0123456789abcdef",
    gitBranch: "main",
    modelLabel: "deepseek-v4-pro",
    thinkingLabel: "High",
    permissionMode: "ask" as const,
    mode: "chat" as const,
    contextUsedTokens: 2500,
    contextMaxTokens: 10_000
  };
  const layout = footerLayout(data, 100);
  assert.match(layout.workspace, /\/tmp\/workspace \(main\) • 01234567/u);
  // 日期前缀的会话 id 要取末段随机后缀，否则每个会话看起来都一样。
  assert.equal(shortSessionId("20260726-041954-481e7876"), "481e7876");
  assert.equal(shortSessionId("0123456789abcdef"), "01234567");
  assert.equal(shortSessionId("short"), "short");
  const stats = `${layout.context}${layout.meta}${layout.gap}${layout.model}`;
  assert.match(stats, /ctx 25%\/10k/u);
  assert.match(stats, /ask/u);
  assert.match(stats, /deepseek-v4-pro • high$/u);
  assert.equal(visibleWidth(stats), 100);

  const narrow = footerLayout({ ...data, modelLabel: "very-long-model-name" }, 12);
  assert.equal(visibleWidth(`${narrow.context}${narrow.meta}${narrow.gap}${narrow.model}`) <= 12, true);
  assert.equal(visibleWidth(narrow.workspace) <= 12, true);

  for (const line of plainLines(new FooterComponent(data).render(60))) {
    assert.equal(visibleWidth(line) <= 60, true, line);
  }

  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(2_500), "2.5k");
  assert.equal(formatTokens(128_000), "128k");
  assert.equal(formatTokens(2_000_000), "2.0M");
}

function testStatusAndShortcutHints(): void {
  setTheme("dark");
  assert.match(statusMessage("running", 2), /Working… · 2 queued \(esc to interrupt\)/u);
  assert.match(statusMessage("waiting_permission", 0), /Waiting for approval/u);
  assert.equal(statusMessage("idle", 0), "");

  const busy = shortcutHints("running", "chat").map((hint) => hint.key);
  assert.equal(busy.includes("esc"), true);
  const planHint = shortcutHints("idle", "plan").find((hint) => hint.key === "shift+tab");
  assert.equal(planHint?.description, "chat mode");

  // 窄终端整条丢弃，不把单条提示截半句。
  const visible = visibleShortcutHints(shortcutHints("idle", "chat"), 14);
  const rendered = visible.map((hint) => `${hint.key} ${hint.description}`).join(" · ");
  assert.equal(visibleWidth(rendered) <= 14, true);

  const bar = new ShortcutsBarComponent();
  bar.setState("idle", "chat");
  for (const line of plainLines(bar.render(50))) assert.equal(visibleWidth(line) <= 50, true, line);
}

function testWelcomeRendersOnboarding(): void {
  setTheme("dark");
  const lines = plainLines(new WelcomeComponent("~/CodingAgent/biny", "0.2.2").render(70));
  const text = lines.join("\n");
  assert.match(text, /Biny v0\.2\.2/u);
  assert.match(text, /Workspace · ~\/CodingAgent\/biny/u);
  assert.match(text, /local agent is ready/u);
  for (const line of lines) assert.equal(visibleWidth(line) <= 70, true, line);
}

function testDialogsRenderAndHandleKeys(): void {
  setTheme("dark");
  let selected: string | undefined;
  let cancelled = false;
  const select = new SelectDialog({
    title: "Select model",
    items: [
      { value: "a", label: "alpha", description: "first" },
      { value: "b", label: "beta", description: "second" }
    ],
    onSelect: (item) => { selected = item.value; },
    onCancel: () => { cancelled = true; }
  });
  const selectText = plainLines(select.render(50)).join("\n");
  assert.match(selectText, /Select model/u);
  assert.match(selectText, /alpha/u);
  select.handleInput("\u001B[B");
  select.handleInput("\r");
  assert.equal(selected, "b");
  select.handleInput("\u001B");
  assert.equal(cancelled, true);

  let closed = false;
  const content = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join("\n");
  const viewer = new TextViewerDialog("Details", content, 5, () => { closed = true; });
  const firstPage = plainLines(viewer.render(40)).join("\n");
  assert.match(firstPage, /line 0/u);
  assert.equal(firstPage.includes("line 20"), false);
  viewer.handleInput("\u001B[6~");
  assert.match(plainLines(viewer.render(40)).join("\n"), /line 4/u);
  viewer.handleInput("\u001B");
  assert.equal(closed, true);
}

function testPermissionDialogRequiresFullYes(): void {
  setTheme("dark");
  const request: TuiPermissionRequest = {
    tool: "run_command",
    title: "Command execution request",
    details: "sudo example",
    requireFullYes: true,
    actionType: "shell",
    riskLevel: "critical"
  };
  const answers: PermissionChoice[] = [];
  let detailsToggled = 0;
  const dialog = new PermissionDialog(request, (choice) => answers.push(choice), () => { detailsToggled += 1; });

  const rendered = plainLines(dialog.render(60)).join("\n");
  assert.match(rendered, /Command execution request/u);
  assert.match(rendered, /Critical or sensitive operation/u);
  assert.match(rendered, /Type yes, then press enter/u);

  // 强确认下直接回车不通过，要先输入完整 yes。
  dialog.handleInput("\r");
  assert.deepEqual(answers, []);
  assert.match(plainLines(dialog.render(60)).join("\n"), /must be the full word yes/u);
  for (const char of "yes") dialog.handleInput(char);
  dialog.handleInput("\r");
  assert.deepEqual(answers, ["approve_once"]);

  dialog.handleInput("\u000F");
  assert.equal(detailsToggled, 1);

  // 拒绝不需要确认词。
  const rejectAnswers: PermissionChoice[] = [];
  const rejectDialog = new PermissionDialog(request, (choice) => rejectAnswers.push(choice), () => undefined);
  rejectDialog.handleInput("\u001B");
  assert.deepEqual(rejectAnswers, ["reject"]);
}

function testDiffStylesUseThemeTokens(): void {
  assert.deepEqual(diffLineStyle("+new code"), { color: "toolDiffAdded" });
  assert.deepEqual(diffLineStyle("-old code"), { color: "toolDiffRemoved" });
  assert.deepEqual(diffLineStyle("@@ -1 +1 @@"), { color: "toolDiffContext", dim: true });
}

function testTranscriptTextHelpers(): void {
  assert.equal(formatToolDuration(undefined), "");
  assert.equal(formatToolDuration(940), "940ms");
  assert.equal(formatToolDuration(1_234), "1.2s");
  assert.equal(formatToolDuration(75_000), "1m 15s");

  const foldables = foldableTranscriptItems({
    committed: [
      { id: "u1", kind: "user", content: "hi" },
      { id: "t1", kind: "tool", tool: "read_file", title: "Read a", argsSummary: "a", status: "success" }
    ],
    active: [{ id: "r1", kind: "reasoning", content: "thinking" }]
  });
  assert.deepEqual(foldables.map((item) => item.id), ["t1", "r1"]);
}

async function testSlashAutocompleteInsertsSingleSlash(): Promise<void> {
  // 补全器要的是不带斜杠的命令名，传成 `/resume` 会补出 `//resume`。
  const provider = new CombinedAutocompleteProvider(
    TUI_SLASH_COMMANDS.map((command) => ({
      name: command.name.replace(/^\//, ""),
      description: command.description
    })),
    process.cwd()
  );

  const controller = new AbortController();
  const suggestions = await provider.getSuggestions(["/res"], 0, 4, { signal: controller.signal });
  assert.ok(suggestions);
  const resume = suggestions.items.find((item) => item.value === "resume");
  assert.ok(resume, "should suggest resume");

  const applied = provider.applyCompletion(["/res"], 0, 4, resume, suggestions.prefix);
  assert.deepEqual(applied.lines, ["/resume "]);

  // 分发时对多余斜杠有容错，避免历史输入或粘贴直接变成未知命令。
  assert.equal(normalizeSlashCommand("//resume"), "/resume");
  assert.equal(normalizeSlashCommand("/resume abc"), "/resume abc");
}

/** 与 app.ts 中 handleSlashCommand 的归一化保持一致。 */
function normalizeSlashCommand(value: string): string {
  return value.trim().replace(/^\/+/, "/");
}

await main();
