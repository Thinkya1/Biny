import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "ink";
import { Transcript } from "../src/tui/components/Transcript.js";
import { TranscriptViewer, transcriptViewerPage } from "../src/tui/components/TranscriptViewer.js";
import { diffLineStyle } from "../src/tui/diffLines.js";
import { createInitialTuiState, tuiReducer } from "../src/tui/state.js";
import { sessionEventsToTranscript } from "../src/tui/sessionTranscript.js";
import {
  clampTerminalLines,
  stripAnsi,
  terminalWidth,
  truncateToTerminalWidth,
  wrapTerminalLines
} from "../src/tui/terminalText.js";
import { transcriptRowsForDisplay, visibleTranscriptRows, type TranscriptDisplayRow } from "../src/tui/transcriptRows.js";
import { latestExpandableTranscript } from "../src/tui/transcriptViewer.js";
import type { ToolTranscriptItem } from "../src/tui/types.js";
import { statusBarLayout } from "../src/tui/components/StatusBar.js";
import type { SessionEvent } from "../src/session/recorder.js";

function main(): void {
  testStripAnsi();
  testTerminalWidth();
  testTruncateToTerminalWidth();
  testWrapTerminalLines();
  testClampTerminalLines();
  testTranscriptUsesIndependentItemKinds();
  testRuntimeStatusEventsReachFooterState();
  testAssistantStreamingUpdatesOneActiveCell();
  testToolProgressUpdatesOneActiveCell();
  testToolDurationMeasuredInUi();
  testActiveToolShowsLatestOutput();
  testParallelToolsUpdateById();
  testDuplicateCompletionDoesNotFinishSiblingTool();
  testReusedToolCallIdKeepsUniqueTranscriptCells();
  testRecoverableErrorDoesNotFinalizeSiblingTools();
  testPermissionRejectionKeepsTurnRunning();
  testLongCommandStaysInFoldedDetails();
  testCommandDisplayNeverLeaksRawCommand();
  testNarrowToolCellFitsViewport();
  testLongSingleLineWrapsBeforeFourRowClamp();
  testFailedCommandCommitsOneToolItem();
  testErrorFinalizesActiveCells();
  testSessionReplayUsesToolItems();
  testSessionReplayFinalizesPendingTools();
  testViewportKeepsLatestRowsVisible();
  testFooterContainsOnlyRuntimeSummary();
  testTranscriptComponentRendersToolHierarchy();
  testTranscriptViewerPagesByVisualLines();
  testTranscriptViewerFitsNarrowViewport();
  testDiffUsesForegroundSemanticColors();
}

function testStripAnsi(): void {
  assert.equal(stripAnsi("\u001B[31m错误\u001B[0m plain"), "错误 plain");
  assert.equal(stripAnsi("\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007"), "link");
}

function testTerminalWidth(): void {
  assert.equal(terminalWidth("plain"), 5);
  assert.equal(terminalWidth("中文"), 4);
  assert.equal(terminalWidth("e\u0301"), 1);
  assert.equal(terminalWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(terminalWidth("🇨🇳"), 2);
  assert.equal(terminalWidth("\u001B[32m中文\u001B[0m"), 4);
}

function testTruncateToTerminalWidth(): void {
  assert.equal(truncateToTerminalWidth("abcdef", 4), "abc…");
  assert.equal(truncateToTerminalWidth("中文测试", 5), "中文…");
  assert.equal(truncateToTerminalWidth("中文", 1), "…");
  assert.equal(truncateToTerminalWidth("abcdef", 0), "");
  assert.equal(truncateToTerminalWidth("abcdef", 4, ".."), "ab..");

  const colored = truncateToTerminalWidth("\u001B[31mabcdef\u001B[0m", 4);
  assert.equal(stripAnsi(colored), "abc…");
  assert.equal(terminalWidth(colored), 4);
  assert.match(colored, /\u001B\[0m$/u);
}

function testWrapTerminalLines(): void {
  assert.deepEqual(wrapTerminalLines("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapTerminalLines("你好世界", 4), ["你好", "世界"]);
  assert.deepEqual(wrapTerminalLines("e\u0301e\u0301", 1), ["e\u0301", "e\u0301"]);
  assert.deepEqual(wrapTerminalLines("👨‍👩‍👧‍👦x", 2), ["👨‍👩‍👧‍👦", "x"]);
  assert.deepEqual(wrapTerminalLines("a\n\nb\n", 4), ["a", "", "b", ""]);

  const colored = wrapTerminalLines("\u001B[31mabcd\u001B[0m", 2);
  assert.deepEqual(colored.map(stripAnsi), ["ab", "cd"]);
  assert.deepEqual(colored.map(terminalWidth), [2, 2]);
}

function testClampTerminalLines(): void {
  assert.deepEqual(clampTerminalLines("abcdefghij", 2, 4), {
    lines: ["ab", "cd", "ef", "gh"],
    hiddenLines: 1
  });
  assert.deepEqual(clampTerminalLines("a\n\nb", 10, 2), {
    lines: ["a", ""],
    hiddenLines: 1
  });
  assert.deepEqual(clampTerminalLines("中文测试完成", 4, 2), {
    lines: ["中文", "测试"],
    hiddenLines: 1
  });
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
  const output = transcriptRowsForDisplay(state.transcript, 80)
    .filter((row) => row.kind === "tool-output" && !row.omitted)
    .map(rowText);
  assert.equal(output.some((line) => line.includes("line 1")), false);
  assert.equal(output.some((line) => line.includes("line 8")), true);
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

  const collapsed = transcriptRowsForDisplay(state.transcript, 40).map(rowText).join("\n");
  assert.equal(collapsed.includes(command), false);
  assert.equal(collapsed.includes("Exit code"), false);
  const expanded = transcriptRowsForDisplay(state.transcript, 40, tool.id).map(rowText).join("\n");
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

function testNarrowToolCellFitsViewport(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "cjk", tool: "read_file", args: { path: "非常长的中文文件名.ts" } });
  state = tuiReducer(state, { type: "tool.call.completed", toolCallId: "cjk", tool: "read_file", result: { path: "非常长的中文文件名.ts", content: "中文输出内容继续延长", durationMs: 1234 } });

  for (const width of [1, 12, 20]) {
    const rows = transcriptRowsForDisplay(state.transcript, width);
    for (const row of rows) assert.equal(terminalWidth(rowText(row)) <= width, true, `${width}: ${rowText(row)}`);
  }
  const narrowMessages = transcriptRowsForDisplay({
    committed: [{ id: "user", kind: "user", content: "中文" }],
    active: []
  }, 1);
  for (const row of narrowMessages) assert.equal(terminalWidth(rowText(row)) <= 1, true);
  const title = transcriptRowsForDisplay(state.transcript, 20).find((row) => row.kind === "tool-title");
  assert.equal(title?.kind === "tool-title" ? title.duration : "", "1.2s");
}

function testLongSingleLineWrapsBeforeFourRowClamp(): void {
  let state = createInitialTuiState("/workspace");
  state = tuiReducer(state, { type: "tool.call.started", toolCallId: "long-output", tool: "run_command", args: { command: "printf output" } });
  state = tuiReducer(state, {
    type: "tool.call.completed",
    toolCallId: "long-output",
    tool: "run_command",
    result: { stdout: "x".repeat(100), stderr: "", exitCode: 0 }
  });
  const rows = transcriptRowsForDisplay(state.transcript, 12);
  const outputRows = rows.filter((row) => row.kind === "tool-output" && !row.omitted);
  const omitted = rows.find((row) => row.kind === "tool-output" && row.omitted);
  assert.equal(outputRows.length, 4);
  assert.match(omitted?.kind === "tool-output" ? omitted.text : "", /6 more/);
  const tool = state.transcript.committed[0] as ToolTranscriptItem;
  assert.equal(tool.output?.length, 100);
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
  const collapsed = transcriptRowsForDisplay(state.transcript, 80).map(rowText).join("\n");
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
    { type: "tool_call", toolCallId: "read-1", tool: "read_file", args: { path: "README.md" }, time: "2026-07-12T00:00:01.000Z" },
    { type: "tool_result", toolCallId: "read-1", tool: "read_file", result: { path: "README.md", content: "line 1\nline 2" }, time: "2026-07-12T00:00:03.500Z" },
    { type: "assistant_message", content: "done" }
  ] as SessionEvent[]);
  assert.deepEqual(items.map((item) => item.kind), ["user", "tool", "assistant"]);
  const tool = items[1] as ToolTranscriptItem;
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

function testViewportKeepsLatestRowsVisible(): void {
  const transcript = {
    committed: Array.from({ length: 6 }, (_, index) => ({ id: `notification-${String(index)}`, kind: "notification" as const, content: `line ${String(index)}` })),
    active: []
  };
  const latest = visibleTranscriptRows(transcript, { width: 20, height: 2, scrollOffset: 0, followLatest: true });
  assert.deepEqual(latest.map(rowText), ["• line 4", "• line 5"]);
  const scrolled = visibleTranscriptRows(transcript, { width: 20, height: 2, scrollOffset: 2, followLatest: false });
  assert.deepEqual(scrolled.map(rowText), ["• line 2", "• line 3"]);
}

function testFooterContainsOnlyRuntimeSummary(): void {
  const layout = statusBarLayout({
    modelLabel: "deepseek-v4-pro",
    contextUsedTokens: 2500,
    contextMaxTokens: 10_000,
    status: "running",
    mode: "chat",
    width: 100
  });
  const text = `${layout.model}${layout.context}${layout.status}${layout.gap}${layout.shortcuts}`;
  assert.match(text, /deepseek-v4-pro/);
  assert.match(text, /ctx 25%/);
  assert.match(text, /running/);
  assert.match(text, /esc stop/);
  assert.equal(text.includes("Snapshot"), false);
  assert.equal(text.includes("RepoMap"), false);
  assert.equal(terminalWidth(text), 100);

  const narrow = statusBarLayout({ modelLabel: "very-long-model-name", status: "idle", mode: "chat", width: 12 });
  assert.equal(terminalWidth(`${narrow.model}${narrow.context}${narrow.status}${narrow.gap}${narrow.shortcuts}`) <= 12, true);
}

function testTranscriptComponentRendersToolHierarchy(): void {
  const transcript = {
    committed: [{
      id: "tests",
      kind: "tool" as const,
      tool: "run_command",
      title: "Ran tests",
      argsSummary: "pnpm test",
      status: "success" as const,
      output: "tests passed\nline two\nline three\nline four\nline five",
      details: "Command: pnpm test\nExit code: 0\n\nstdout:\ntests passed",
      durationMs: 1234
    }],
    active: []
  };
  const output = stripAnsi(renderToString(React.createElement(Transcript, {
    transcript,
    width: 40,
    height: 8,
    scrollOffset: 0,
    followLatest: true
  }), { columns: 40 }));
  assert.match(output, /• Ran tests\s+1\.2s/);
  assert.match(output, /└ tests passed/);
  assert.match(output, /… 1 more/);
  for (const line of output.split("\n")) assert.equal(terminalWidth(line) <= 40, true);
}

function testTranscriptViewerPagesByVisualLines(): void {
  const first = transcriptViewerPage("中".repeat(40), 10, 6, 0);
  assert.equal(first.lines.length, 8);
  assert.equal(first.bodyRows, 3);
  assert.equal(first.maxScroll, 5);
  assert.equal(first.visible.length, 3);
  for (const line of first.lines) assert.equal(terminalWidth(line) <= 10, true);

  const last = transcriptViewerPage("中".repeat(40), 10, 6, 99);
  assert.equal(last.safeScrollTop, 5);
  assert.deepEqual(last.visible, last.lines.slice(5));
}

function testTranscriptViewerFitsNarrowViewport(): void {
  const output = stripAnsi(renderToString(React.createElement(TranscriptViewer, {
    transcript: { title: "A very long command detail title", content: "x".repeat(100) },
    width: 10,
    height: 6,
    onExit: () => undefined
  }), { columns: 10 }));
  const lines = output.split("\n");
  assert.equal(lines.length <= 6, true);
  for (const line of lines) assert.equal(terminalWidth(line) <= 10, true, line);
}

function testDiffUsesForegroundSemanticColors(): void {
  assert.deepEqual(diffLineStyle("+new code"), { color: "#4EC87E" });
  assert.deepEqual(diffLineStyle("-old code"), { color: "#E85454" });
  assert.equal("backgroundColor" in (diffLineStyle("+new code") ?? {}), false);
  assert.equal("fillBackground" in (diffLineStyle("+new code") ?? {}), false);
}

function rowText(row: TranscriptDisplayRow): string {
  if (row.kind === "message") return `${row.prefix}${row.text}`;
  if (row.kind === "tool-title") return `${row.marker}${row.title}${row.gap}${row.duration}`;
  if (row.kind === "tool-output") return `${row.prefix}${row.text}`;
  return "";
}

main();
