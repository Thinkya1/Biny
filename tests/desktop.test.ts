import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRunOptions, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { ContextStatus } from "../src/agent/context/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { pendingPermission, type AgentHostEvent } from "../src/runtime/agentEvents.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import type { CredentialStore } from "../src/config/credentials.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopProject } from "../src/desktop/protocol.js";
import { clampFilePanelWidth, DEFAULT_FILE_PANEL_WIDTH, MAX_FILE_PANEL_WIDTH, MIN_FILE_PANEL_WIDTH } from "../src/desktop/filePanelSizing.js";
import {
  canNavigateBack,
  canNavigateForward,
  createNavigationState,
  moveNavigation,
  pushNavigation,
  replaceNavigation
} from "../src/desktop/renderer/src/navigationHistory.js";
import { activeTimelineTool, buildSessionTimeline, listChangedFiles, listTimelineFiles, timelineToolEntries } from "../src/desktop/renderer/src/sessionTimeline.js";
import { reasoningDetailText } from "../src/desktop/renderer/src/reasoningPresentation.js";
import { projectWebSearchView } from "../src/desktop/renderer/src/webSearchPresentation.js";
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import { catalogForConnection, customCatalogEntry } from "../src/desktop/renderer/src/providerCatalog.js";
import { highlightFencedCode, highlightWorkspaceFile } from "../src/desktop/renderer/src/syntaxHighlight.js";
import { splitAttachmentReferences, withAttachmentReferences } from "../src/desktop/attachmentReferences.js";
import { tokenizeCommand } from "../src/desktop/renderer/src/commandHighlight.js";
import { workspaceFileMarker } from "../src/desktop/renderer/src/workspaceFileMarker.js";
import { listModelChoices, ModelManager } from "../src/llm/ModelManager.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { listSessionSummaries, readStoredSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs, resolveSessionFile, sessionFilePath } from "../src/session/store.js";

const execFileAsync = promisify(execFile);

await testInteractiveRuntimeProtocol();
await testInteractiveRuntimeRedactsToolEvents();
await testInteractiveRuntimeRedactsRunText();
await testInteractiveRuntimeStrongConfirmation();
await testPermissionRequiredToolResultIsFailed();
await testInteractiveRuntimeAbort();
await testDraftSessionsDoNotReachTheSessionList();
await testDesktopMessageEditFork();
await testWorkspaceFilePreview();
await testWorkspaceDirectoryListing();
await testDesktopGitInspectionDisablesHelpers();
testWorkspaceSyntaxHighlighting();
testFencedCodeHighlighting();
testAttachmentReferenceRoundTrip();
await testInlineImageReading();
testCommandHighlighting();
testWorkspaceFileMarkers();
await testFilePanelSizing();
await testDesktopThemePreference();
await testDesktopModelConfiguration();
await testDesktopSubagentSlashCommands();
await testDesktopReportsRuntimeLeaseConflict();
await testDesktopCredentialsAreSeparated();
await testDesktopWebSearchSettings();
await testDesktopRequiresModelConfiguration();
await testDesktopConnectionMetadata();
await testWorkspaceSnapshotDoesNotReorderProjects();
await testDesktopProjectReorder();
await testLegacyDesktopDataMigration();
testProviderCatalogResolution();
testModelChoicesDeduplicateEquivalentAliases();
testHistoricalAbortProjection();
testHistoricalUsageProjection();
testHistoricalToolProjection();
testWebSearchProjection();
testHistoricalReasoningAndSkillProjection();
testExecutionTimelineKeepsReasoningAndToolsInOrder();
testLiveExecutionTimelineKeepsReasoningAndToolsInOrder();
testLiveAssistantCompletionDoesNotDuplicateDelta();
testVerifierPromptIsNotRenderedAsUserMessage();
testHistoricalPrefixKeepsUnpersistedDuplicatePrompt();
testHistoricalEmptyAssistantDoesNotEraseReply();
testChangedFileProjection();
testLiveTimelineProjection();
testLiveReasoningAndSkillProjection();
testReasoningDetailDoesNotUseCompletionStatusAsContent();
testDesktopNavigationHistory();
testPendingPermissionToolSelection();

async function testInteractiveRuntimeProtocol(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let resolvePermission!: (event: Extract<AgentHostEvent, { type: "permission.requested" }>) => void;
  const permissionRequested = new Promise<Extract<AgentHostEvent, { type: "permission.requested" }>>((resolve) => {
    resolvePermission = resolve;
  });
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "permission.requested") resolvePermission(event);
  });

  const submitted = runtime.submitPrompt("modify file");
  const permission = await permissionRequested;
  assert.equal(permission.toolCallId, "tool-1");
  runtime.answerPermission(permission.requestId, { approved: true, scope: "once" });
  await submitted.completion;

  assert.deepEqual(events.map((event) => event.type), [
    "message.user",
    "run.started",
    "reasoning.started",
    "reasoning.completed",
    "tool.started",
    "reasoning.status",
    "permission.requested",
    "permission.resolved",
    "tool.completed",
    "file.changed",
    "assistant.delta",
    "assistant.completed",
    "context.updated",
    "run.completed"
  ]);
  assert.ok(events.every((event) => event.sessionId === "session-1" && event.runId && event.timestamp));
  await runtime.close();
}

async function testInteractiveRuntimeRedactsToolEvents(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "permission.requested") {
      runtime.answerPermission(event.requestId, { approved: true, scope: "once" });
    }
  });

  await runtime.submitPrompt("secret").completion;
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("opaque-live-tool-secret"), false);
  assert.match(serialized, /\[redacted\]/);
  const started = events.find((event): event is Extract<AgentHostEvent, { type: "tool.started" }> => event.type === "tool.started");
  const completed = events.find((event): event is Extract<AgentHostEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  assert.equal((started?.args as { apiKey?: string } | undefined)?.apiKey, "[redacted]");
  assert.equal((completed?.result as { safe?: string } | undefined)?.safe, "visible");
  await runtime.close();
}

async function testInteractiveRuntimeRedactsRunText(): Promise<void> {
  for (const input of ["secret-event-error", "secret-thrown-error"]) {
    const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
    const events: AgentHostEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const outcome = await runtime.submitPrompt(input).completion;
    const serialized = JSON.stringify({ events, outcome });
    assert.equal(serialized.includes("opaque-live-run-secret"), false);
    assert.match(serialized, /\[redacted\]/);
    assert.equal(events.some((event) => event.type === "run.failed"), true);
    await runtime.close();
  }

  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  await assert.rejects(runtime.runSubagentTask("secret-subagent-failure"), /\[redacted\]/);
  assert.equal(JSON.stringify(events).includes("opaque-live-run-secret"), false);
  await runtime.close();
}

async function testInteractiveRuntimeStrongConfirmation(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime(true));
  let resolvePermission!: (event: Extract<AgentHostEvent, { type: "permission.requested" }>) => void;
  const permissionRequested = new Promise<Extract<AgentHostEvent, { type: "permission.requested" }>>((resolve) => {
    resolvePermission = resolve;
  });
  runtime.subscribe((event) => {
    if (event.type === "permission.requested") resolvePermission(event);
  });

  const submitted = runtime.submitPrompt("modify critical file");
  const permission = await permissionRequested;
  assert.equal(permission.request.requireFullYes, true);
  assert.throws(
    () => runtime.answerPermission(permission.requestId, { approved: true, scope: "once" }),
    /requires the full word yes/u
  );
  assert.equal(pendingPermission(runtime.getSnapshot())?.requestId, permission.requestId);
  assert.throws(
    () => runtime.answerPermission(permission.requestId, { approved: true, scope: "once", confirmation: "y" }),
    /requires the full word yes/u
  );
  runtime.answerPermission(permission.requestId, { approved: true, scope: "once", confirmation: " YES " });
  assert.equal((await submitted.completion).status, "completed");
  await runtime.close();
}

async function testPermissionRequiredToolResultIsFailed(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "permission.requested") {
      runtime.answerPermission(event.requestId, { approved: true, scope: "once" });
    }
  });

  await runtime.submitPrompt("stale").completion;
  assert.equal(events.some((event) => event.type === "tool.failed" && /target changed/i.test(event.error)), true);
  assert.equal(events.some((event) => event.type === "tool.completed" || event.type === "file.changed"), false);
  await runtime.close();
}

function testPendingPermissionToolSelection(): void {
  const tools: TimelineTool[] = [
    { id: "write-1", tool: "write_file", args: {}, status: "success", updates: [] },
    {
      id: "write-2",
      tool: "write_file",
      args: {},
      status: "running",
      updates: [],
      permission: {
        requestId: "permission-2",
        resolved: false,
        request: {
          toolCallId: "write-2",
          tool: "write_file",
          title: "Allow write",
          details: "Write another file",
          requireFullYes: true,
          actionType: "write",
          riskLevel: "critical"
        }
      }
    }
  ];
  assert.equal(activeTimelineTool(tools)?.id, "write-2");
  assert.deepEqual(timelineToolEntries(tools).map((entry) => [entry.key, entry.label]), [
    ["write-1", "write_file 1"],
    ["write-2", "write_file 2 · 待授权"]
  ]);
}

async function testInteractiveRuntimeAbort(): Promise<void> {
  const runtime = new InteractiveAgentRuntime(fakeCommandRuntime());
  const events: AgentHostEvent[] = [];
  let started!: () => void;
  const runStarted = new Promise<void>((resolve) => { started = resolve; });
  runtime.subscribe((event) => {
    events.push(event);
    if (event.type === "run.started") started();
  });
  const submitted = runtime.submitPrompt("cancel");
  await runStarted;
  runtime.cancelCurrentRun();
  await submitted.completion;
  assert.equal(events.at(-1)?.type, "run.aborted");
  await runtime.close();
}

async function testDraftSessionsDoNotReachTheSessionList(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-draft-session-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const draft = new SessionRecorder(workspaceRoot, "draft");
    await access(draft.filePath);
    await assert.rejects(resolveSessionFile(workspaceRoot, "latest"), /No sessions found/);
    await draft.close();
    await assert.rejects(access(draft.filePath));
    await writeFile(sessionFilePath(workspaceRoot, "legacy-empty"), "");
    await writeFile(sessionFilePath(workspaceRoot, "legacy-error"), `${JSON.stringify({ type: "error", message: "No model available" })}\n`);
    assert.deepEqual(await listSessionSummaries(workspaceRoot), []);

    const activeDraft = new SessionRecorder(workspaceRoot, "draft");
    activeDraft.record({ type: "user_message", content: "Create a project" });
    await activeDraft.close();
    assert.deepEqual((await listSessionSummaries(workspaceRoot)).map((session) => session.fileName), ["draft.jsonl"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testDesktopMessageEditFork(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-edit-fork-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-edit-fork-data-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const dataRoot = await projects.dataRoot(project);
    await ensureAgentDirs(dataRoot);
    const source = new SessionRecorder(dataRoot, "source-session");
    source.record({ type: "user_message", content: "第一条" });
    source.record({ type: "assistant_message", content: "第一条回复" });
    source.record({ type: "user_message", content: "旧的第二条" });
    source.record({ type: "assistant_message", content: "旧的第二条回复" });
    await source.close();

    const forkedSessionId = await projects.forkSessionAtUserMessage(project, "source-session", 1);
    const forked = await readStoredSessionEvents(dataRoot, forkedSessionId);
    assert.deepEqual(forked.events.map((event) => event.type), ["user_message", "assistant_message"]);
    assert.equal(forked.events[0]?.type === "user_message" ? forked.events[0].content : undefined, "第一条");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testWorkspaceFilePreview(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-preview-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await writeFile(path.join(workspaceRoot, "hello.py"), "print('hello')\n");
    assert.deepEqual(await projects.readWorkspaceFile(project, "hello.py"), {
      path: "hello.py",
      content: "print('hello')\n",
      bytes: 15,
      binary: false,
      truncated: false
    });
    await writeFile(path.join(workspaceRoot, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const binary = await projects.readWorkspaceFile(project, "image.bin");
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
    await writeFile(path.join(workspaceRoot, "large.txt"), "a".repeat(512 * 1024 + 8));
    const large = await projects.readWorkspaceFile(project, "large.txt");
    assert.equal(large.content?.length, 512 * 1024);
    assert.equal(large.truncated, true);
    await assert.rejects(projects.readWorkspaceFile(project, "../outside.txt"), /Path escapes workspace/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testWorkspaceDirectoryListing(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-directory-listing-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-directory-outside-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(path.join(workspaceRoot, "README.md"), "# Biny\n");
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");

    const root = await projects.listWorkspaceDirectory(project, ".");
    assert.equal(root.path, ".");
    assert.deepEqual(root.entries.map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind })), [
      { name: ".biny", path: ".biny", kind: "directory" },
      { name: "src", path: "src", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" }
    ]);
    const nested = await projects.listWorkspaceDirectory(project, "src");
    assert.deepEqual(nested.entries.map((entry) => entry.path), ["src/index.ts"]);
    await assert.rejects(projects.listWorkspaceDirectory(project, "../outside"), /Path escapes workspace/);
    await assert.rejects(projects.listWorkspaceDirectory(project, ".git"), /ignored by workspace policy/);
    await symlink(outsideRoot, path.join(workspaceRoot, "outside-link"), "dir");
    await assert.rejects(projects.listWorkspaceDirectory(project, "outside-link"), /symbolic link/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

async function testDesktopGitInspectionDisablesHelpers(): Promise<void> {
  if (process.platform === "win32") return;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-git-data-"));
  const sentinel = path.join(workspaceRoot, "fsmonitor-ran.txt");
  const helper = path.join(workspaceRoot, "fsmonitor-helper.mjs");
  try {
    await writeFile(helper, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`
    ].join("\n"), "utf8");
    await chmod(helper, 0o755);
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await execFileAsync("git", ["config", "core.fsmonitor", helper], { cwd: workspaceRoot });
    const { projects } = await createDesktopTestServices(desktopRoot);
    await projects.createProject(workspaceRoot);
    await assert.rejects(access(sentinel));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

function testWorkspaceSyntaxHighlighting(): void {
  const highlighted = highlightWorkspaceFile("src/index.ts", "const answer: number = 42;\n");
  assert.equal(highlighted.language, "typescript");
  assert.match(highlighted.html, /hljs-keyword/);
  assert.match(highlighted.html, /hljs-number/);
}

function testFencedCodeHighlighting(): void {
  const typescript = highlightFencedCode("const answer: number = 42;", "ts");
  assert.equal(typescript.language, "typescript");
  assert.match(typescript.html, /hljs-keyword/);

  // 认不出的语言标注不高亮，但仍然要转义后交出去。
  const unknown = highlightFencedCode("<script>alert(1)</script>", "brainfuck");
  assert.equal(unknown.language, undefined);
  assert.equal(unknown.html, "&lt;script&gt;alert(1)&lt;/script&gt;");
}

function testAttachmentReferenceRoundTrip(): void {
  const prompt = withAttachmentReferences("看下这张图", [
    { name: "shot.png", path: "@attachments/1753600000000-a1b2c3-shot.png", mimeType: "image/png", size: 2048 }
  ]);
  const split = splitAttachmentReferences(prompt);
  assert.equal(split.text, "看下这张图");
  assert.deepEqual(split.attachments, [
    { path: "@attachments/1753600000000-a1b2c3-shot.png", name: "shot.png", mimeType: "image/png", size: 2048 }
  ]);

  // 没有附件块，以及格式对不上的历史消息，都要原样返回。
  assert.deepEqual(splitAttachmentReferences("普通消息"), { text: "普通消息", attachments: [] });
  const malformed = "普通消息\n\nAttached files (read them with read_file using these @attachments/ paths):\n- 说明文字";
  assert.deepEqual(splitAttachmentReferences(malformed), { text: malformed, attachments: [] });
}

async function testInlineImageReading(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-inline-image-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-inline-image-desktop-"));
  try {
    const { projects } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    await writeFile(path.join(workspaceRoot, "shot.gif"), pixel);
    const attachment = await projects.saveAttachment(project, "shot.gif", "image/gif", pixel);

    assert.equal(await projects.readInlineImage(project, "shot.gif"), `data:image/gif;base64,${pixel.toString("base64")}`);
    assert.equal(await projects.readInlineImage(project, attachment.path), `data:image/gif;base64,${pixel.toString("base64")}`);
    // 非图片、越界路径和不存在的文件都只是「没图」，不能抛错打断消息渲染。
    assert.equal(await projects.readInlineImage(project, "notes.txt"), undefined);
    assert.equal(await projects.readInlineImage(project, "../outside.png"), undefined);
    assert.equal(await projects.readInlineImage(project, "@attachments/../../escape.png"), undefined);
    assert.equal(await projects.readInlineImage(project, "missing.png"), undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

function testCommandHighlighting(): void {
  const kinds = (command: string): string => tokenizeCommand(command).filter((token) => token.text.trim()).map((token) => `${token.kind}:${token.text}`).join(" ");

  assert.equal(kinds("git commit -m \"修复 #12\""), "program:git subcommand:commit flag:-m string:\"修复 #12\"");
  assert.equal(kinds("pnpm run build 2>&1 | tail -n 20"), "program:pnpm subcommand:run plain:build plain:2 operator:>& plain:1 operator:| program:tail flag:-n plain:20");
  assert.equal(kinds("NODE_ENV=test npx vite preview --port=4190 # 预览"), "variable:NODE_ENV operator:= plain:test program:npx subcommand:vite plain:preview flag:--port operator:= plain:4190 comment:# 预览");
  assert.equal(kinds("cat src/index.ts > $HOME/out.log"), "program:cat path:src/index.ts operator:> variable:$HOME path:/out.log");
  assert.equal(kinds("rm -rf ./dist && echo ok"), "program:rm flag:-rf path:./dist operator:&& program:echo plain:ok");
  assert.equal(kinds("$(which node) --version"), "operator:$( program:which plain:node operator:) flag:--version");

  // 引号未闭合、变量残缺这类畸形输入也不能吞字符：拼回去必须和原文一致。
  for (const command of ["node -e \"console.log('x')\" 2>&1", "echo '未闭合", "echo $", "find . -exec rm {} \\;", ""]) {
    assert.equal(tokenizeCommand(command).map((token) => token.text).join(""), command);
  }
}

function testWorkspaceFileMarkers(): void {
  assert.deepEqual(workspaceFileMarker("README.md"), { label: "MD", tone: "markdown" });
  assert.deepEqual(workspaceFileMarker("src/App.tsx"), { label: "TSX", tone: "typescript" });
  assert.deepEqual(workspaceFileMarker("agent.config.json"), { label: "{}", tone: "json" });
  assert.deepEqual(workspaceFileMarker("pnpm-lock.yaml"), { label: "YML", tone: "yaml" });
  assert.deepEqual(workspaceFileMarker(".gitignore"), { label: "◆", tone: "git" });
  assert.deepEqual(workspaceFileMarker("preview.png"), { label: "IMG", tone: "image" });
}

async function testFilePanelSizing(): Promise<void> {
  assert.equal(clampFilePanelWidth(650, 1_000, false), 650);
  assert.equal(clampFilePanelWidth(650, 700, false), 380);
  assert.equal(clampFilePanelWidth(700, 700, true), 656);

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-file-panel-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.filePanelWidth(), DEFAULT_FILE_PANEL_WIDTH);
    await state.setFilePanelWidth(600);
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.filePanelWidth(), 600);
    await restored.setFilePanelWidth(10_000);
    assert.equal(restored.filePanelWidth(), MAX_FILE_PANEL_WIDTH);
    await restored.setFilePanelWidth(1);
    assert.equal(restored.filePanelWidth(), MIN_FILE_PANEL_WIDTH);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testDesktopThemePreference(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-theme-"));
  try {
    const statePath = path.join(workspaceRoot, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.load();
    assert.equal(state.themePreference(), "system");
    await state.setThemePreference("dark");
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.equal(restored.themePreference(), "dark");
    await restored.setThemePreference("light");
    assert.equal(restored.themePreference(), "light");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testDesktopModelConfiguration(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-model-config-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const initialConfig = structuredClone(defaultConfig);
    initialConfig.models["deepseek-deepseek-v4-flash"] = { ...initialConfig.models["deepseek-v4-flash"] };
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    await configStore.save(initialConfig);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    // Enabling an extra model must not hijack the active default — that is what
    // the settings "启用模型" toggles do on every click.
    const enabledOnly = await agents.saveModelConfiguration(project.id, {
      alias: "local-qwen-extra",
      displayName: "本地 Qwen 备用",
      providerAlias: "local",
      providerType: "ollama",
      model: "qwen3:4b",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: undefined,
      apiKey: undefined,
      supportsTools: true,
      supportsThinking: false
    });
    assert.equal((await configStore.load()).defaultModel, "deepseek-v4-flash");
    assert.equal(enabledOnly.models.some((model) => model.alias === "local-qwen-extra"), true);

    const snapshot = await agents.saveModelConfiguration(project.id, {
      alias: "local-qwen",
      displayName: "本地 Qwen",
      providerAlias: "local",
      providerType: "ollama",
      model: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: undefined,
      apiKey: undefined,
      supportsTools: true,
      supportsThinking: false,
      makeDefault: true
    });
    const config = await configStore.load();
    assert.equal(config.defaultModel, "local-qwen");
    assert.equal(config.providers.local?.type, "ollama");
    assert.equal(config.models["local-qwen"]?.model, "qwen3:8b");
    assert.equal(snapshot.models.some((model) => model.alias === "local-qwen"), true);
    const modelManager = new ModelManager(desktopRoot, config, configStore);
    const externallyUpdatedConfig = structuredClone(config);
    externallyUpdatedConfig.defaultModel = "local-qwen-next";
    externallyUpdatedConfig.models["local-qwen-next"] = { ...externallyUpdatedConfig.models["local-qwen"], model: "qwen3:14b", displayName: "本地 Qwen Next" };
    await configStore.save(externallyUpdatedConfig);
    const refreshedInfo = await modelManager.refreshFromDisk();
    assert.equal(refreshedInfo.modelAlias, "local-qwen-next");
    await agents.saveModelConfiguration(project.id, {
      alias: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      providerAlias: "deepseek",
      providerType: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: undefined,
      apiKey: undefined,
      supportsTools: true,
      supportsThinking: true
    });
    const cleanedConfig = await configStore.load();
    assert.equal(cleanedConfig.models["deepseek-deepseek-v4-flash"], undefined);
    await projects.listSessions(project, undefined, new Map());
    const attachment = await projects.saveAttachment(project, "notes.txt", "text/plain", new TextEncoder().encode("desktop only"));
    assert.match(attachment.path, /^@attachments\//);
    // Project sessions and attachments live together, so TUI/CLI can reopen Desktop uploads.
    await access(path.join(workspaceRoot, ".biny", "sessions"));
    await access(path.join(workspaceRoot, ".biny", "attachments"));
    await assert.rejects(access(path.join(desktopRoot, "projects", project.id, ".biny", "attachments")));
    await assert.rejects(access(path.join(workspaceRoot, "agent.config.json")));
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopSubagentSlashCommands(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-subagent-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-subagent-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    await mkdir(path.join(workspaceRoot, ".biny", "agents"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".biny", "agents", "planner.md"),
      "---\nname: planner\ndescription: 拆解任务并给出执行计划\n---\n先读代码再给结论。\n"
    );
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);

    // 桌面端 /subagent 与 TUI 同构：agents / status / cancel / 用法提示都不该再抛「仅支持 agents」。
    const list = await agents.runSlashCommand(project.id, undefined, "/subagent agents");
    assert.match(list.content, /planner/);

    const status = await agents.runSlashCommand(project.id, undefined, "/subagent status");
    assert.match(status.content, /No subagent tasks/);

    const cancelMissing = await agents.runSlashCommand(project.id, undefined, "/subagent cancel task-404");
    assert.match(cancelMissing.content, /No active subagent task found for task-404/);

    await assert.rejects(agents.runSlashCommand(project.id, undefined, "/subagent cancel"), /task-id/);
    await assert.rejects(agents.runSlashCommand(project.id, undefined, "/subagent start"), /start/);

    const usage = await agents.runSlashCommand(project.id, undefined, "/subagent");
    assert.match(usage.content, /status \| cancel <task-id> \| agents/);

    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopReportsRuntimeLeaseConflict(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-runtime-lease-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-runtime-lease-data-"));
  let owner: SessionLeaseStore | undefined;
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    owner = await SessionLeaseStore.open(workspaceRoot);
    const recorder = new SessionRecorder(workspaceRoot, "session-owner");
    recorder.record({ type: "user_message", content: "owner session" });
    await recorder.close();
    await state.setSelectedSession(project.id, "session-owner");
    owner.acquire("session-owner");
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await assert.rejects(
      () => agents.setPermissionMode(project.id, "read-only"),
      new RegExp(`当前项目正在被另一个 Biny/CLI 会话占用（进程 ${String(process.pid)}）`)
    );
    const snapshot = await agents.workspaceSnapshot(project.id);
    assert.match(snapshot.runtimeError ?? "", /请先退出该会话，或切换到其他项目后重试/u);
    await agents.closeAll();
  } finally {
    owner?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopCredentialsAreSeparated(): Promise<void> {
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-credentials-"));
  try {
    const store = new DesktopConfigStore(desktopRoot, memoryCredentialStore());
    const config = structuredClone(defaultConfig);
    config.providers.deepseek!.apiKey = "desktop-secret";
    config.web.search.apiKey = "tvly-web-secret";
    await store.save(config);
    const settings = await readFile(path.join(desktopRoot, "agent.config.json"), "utf8");
    assert.doesNotMatch(settings, /desktop-secret/);
    // 联网搜索密钥同样只进凭据后端，不落明文设置文件。
    assert.doesNotMatch(settings, /tvly-web-secret/);
    await assert.rejects(readFile(path.join(desktopRoot, "credentials.json"), "utf8"), /ENOENT/u);
    const loaded = await store.load();
    assert.equal(loaded.providers.deepseek?.apiKey, "desktop-secret");
    assert.equal(loaded.web.search.apiKey, "tvly-web-secret");
  } finally {
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopWebSearchSettings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-web-search-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-web-search-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);

    const initial = await agents.webSearchSettings(project.id);
    assert.equal(initial.enabled, false);
    assert.equal(initial.provider, "anysearch");
    assert.equal(initial.hasApiKey, false);

    const saved = await agents.saveWebSearchSettings(project.id, {
      enabled: true,
      provider: "tavily",
      apiKey: "tvly-test-secret",
      apiKeyEnv: undefined,
      timeoutMs: 8_000,
      maxResults: 6
    });
    assert.equal(saved.provider, "tavily");
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.envKeyName, "TAVILY_API_KEY");
    assert.equal(saved.maxResults, 6);

    // 同 provider 重新保存且未传 apiKey：已存密钥保留。
    const kept = await agents.saveWebSearchSettings(project.id, {
      enabled: true,
      provider: "tavily",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 8_000,
      maxResults: 6
    });
    assert.equal(kept.hasApiKey, true);

    // 切换 provider 且未提供新密钥：旧密钥必须被清除，不能带给新服务商。
    const switched = await agents.saveWebSearchSettings(project.id, {
      enabled: true,
      provider: "brave",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 8_000,
      maxResults: 6
    });
    assert.equal(switched.provider, "brave");
    assert.equal(switched.hasApiKey, false);
    assert.equal(switched.envKeyName, "BRAVE_SEARCH_API_KEY");
    assert.equal((await configStore.load()).web.search.apiKey, undefined);

    const google = await agents.saveWebSearchSettings(project.id, {
      enabled: true,
      provider: "google",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 8_000,
      maxResults: 6
    });
    assert.equal(google.provider, "google");
    assert.equal(google.hasApiKey, false);
    assert.equal(google.envKeyName, undefined);

    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopRequiresModelConfiguration(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-setup-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-setup-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const unconfigured = structuredClone(defaultConfig);
    unconfigured.defaultModel = "setup-model";
    unconfigured.providers = { setup: { type: "openai-compatible", baseUrl: "https://example.com/v1" } };
    unconfigured.models = { "setup-model": { provider: "setup", model: "setup-model", supportsTools: true } };
    unconfigured.thinking = { enabled: false, effort: "high" };
    await configStore.save(unconfigured);
    const initial = await agents.workspaceSnapshot(project.id);
    assert.equal(initial.requiresModelConfiguration, true);
    assert.equal(initial.models.length, 0);

    const configured = structuredClone(unconfigured);
    configured.providers.setup!.apiKey = "desktop-test-key";
    await configStore.save(configured);
    const ready = await agents.workspaceSnapshot(project.id);
    assert.equal(ready.requiresModelConfiguration, false);
    assert.equal(ready.models[0]?.alias, configured.defaultModel);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopConnectionMetadata(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-connections-workspace-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-connections-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const project = await projects.createProject(workspaceRoot);
    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    const config = structuredClone(defaultConfig);
    config.providers.deepseek!.apiKey = "connection-metadata-secret";
    config.providers.subscription = {
      type: "claude-subscription",
      baseUrl: "https://api.anthropic.com",
      apiKey: "oauth-access-token",
      authMode: "oauth-bearer",
      oauth: { provider: "claude-code", expiresAt: 1_900_000_000_000 }
    };
    await configStore.save(config);

    const snapshot = await agents.workspaceSnapshot(project.id);
    const deepseek = snapshot.connections.find((item) => item.providerAlias === "deepseek");
    assert.equal(deepseek?.hasCredential, true);
    assert.equal(deepseek?.credentialSource, process.platform === "darwin" ? "keychain" : "config");
    assert.equal(deepseek?.baseUrl, "https://api.deepseek.com");
    // Presence only — the key itself must never reach the renderer.
    assert.doesNotMatch(JSON.stringify(snapshot.connections), /connection-metadata-secret|oauth-access-token/);

    const subscription = snapshot.connections.find((item) => item.providerAlias === "subscription");
    assert.equal(subscription?.authMode, "oauth-bearer");
    assert.equal(subscription?.oauthProvider, "claude-code");
    assert.equal(subscription?.oauthExpiresAt, 1_900_000_000_000);

    // An unreachable provider degrades to `fallback` instead of throwing, so the
    // settings dialog keeps showing the models it already had.
    const unreachable = structuredClone(config);
    unreachable.providers.deepseek!.baseUrl = "http://127.0.0.1:1/v1";
    unreachable.providers.deepseek!.retry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    await configStore.save(unreachable);
    const catalog = await agents.fetchModelCatalog(project.id, "deepseek");
    assert.equal(catalog.source, "fallback");
    assert.equal(catalog.models.length, 0);
    assert.equal(catalog.providerAlias, "deepseek");
    await assert.rejects(agents.fetchModelCatalog(project.id, "missing-provider"), /missing-provider/);
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testWorkspaceSnapshotDoesNotReorderProjects(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-b-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-order-data-"));
  try {
    const { configStore, projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await projects.createProject(secondRoot);
    const firstOpenedAt = state.project(first.id)?.lastOpenedAt;
    const secondOpenedAt = state.project(second.id)?.lastOpenedAt;
    assert.ok(firstOpenedAt);
    assert.ok(secondOpenedAt);
    assert.notEqual(firstOpenedAt, secondOpenedAt);

    const agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await agents.workspaceSnapshot(first.id);

    assert.equal(state.project(first.id)?.lastOpenedAt, firstOpenedAt);
    assert.equal(state.project(second.id)?.lastOpenedAt, secondOpenedAt);
    assert.deepEqual(state.projects().map((project) => project.id), [first.id, second.id]);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopProjectReorder(): Promise<void> {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-a-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-b-"));
  const thirdRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-c-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-reorder-data-"));
  try {
    const { projects, state } = await createDesktopTestServices(desktopRoot);
    const first = await projects.createProject(firstRoot);
    const second = await projects.createProject(secondRoot);
    const third = await projects.createProject(thirdRoot);
    assert.deepEqual(state.projects().map((project) => project.id), [first.id, second.id, third.id]);

    await state.reorderProjects([third.id, first.id, second.id]);
    assert.deepEqual(state.projects().map((project) => project.id), [third.id, first.id, second.id]);

    await state.reorderProjects([second.id, "missing-project", first.id]);
    assert.deepEqual(state.projects().map((project) => project.id), [second.id, first.id, third.id]);

    // Drag-down semantics: insert after target so moving first→second actually changes order.
    assert.deepEqual(
      reorderSectionProjectIdsForTest([first.id, second.id, third.id], [first.id, second.id, third.id], first.id, second.id, "after"),
      [second.id, first.id, third.id]
    );
    // Drag-up semantics: insert before target.
    assert.deepEqual(
      reorderSectionProjectIdsForTest([first.id, second.id, third.id], [first.id, second.id, third.id], third.id, first.id, "before"),
      [third.id, first.id, second.id]
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
    await rm(thirdRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

function reorderSectionProjectIdsForTest(
  fullIds: string[],
  sectionIds: string[],
  sourceId: string,
  targetId: string,
  placement: "before" | "after"
): string[] {
  const nextSection = sectionIds.filter((projectId) => projectId !== sourceId);
  const targetIndex = nextSection.indexOf(targetId);
  if (targetIndex < 0) return fullIds;
  nextSection.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  const sectionMembers = new Set(sectionIds);
  let sectionIndex = 0;
  return fullIds.map((projectId) => sectionMembers.has(projectId) ? nextSection[sectionIndex++]! : projectId);
}

async function testLegacyDesktopDataMigration(): Promise<void> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "biny-legacy-project-"));
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-data-"));
  try {
    const project: DesktopProject = {
      id: "legacy-project",
      path: projectRoot,
      name: "Legacy Project",
      dirty: false,
      missing: false,
      pinned: false,
      addedAt: "2026-07-18T00:00:00.000Z",
      lastOpenedAt: "2026-07-18T00:00:00.000Z"
    };
    const config = structuredClone(defaultConfig);
    config.defaultModel = "deepseek-v4-pro";
    await saveConfigFile(projectRoot, config);

    const storage = new DesktopUserDataStore(desktopRoot);
    await storage.initialize();
    const configStore = new DesktopConfigStore(desktopRoot, memoryCredentialStore());
    const stateProject: DesktopProject = { ...project, id: "state-project", name: "State Project" };
    const legacyStatePath = path.join(desktopRoot, "legacy-desktop-state.json");
    const destinationStatePath = path.join(desktopRoot, "desktop-state.json");
    await writeFile(legacyStatePath, JSON.stringify({
      version: 1,
      projects: [project],
      activeProjectId: project.id,
      selectedSessionIds: { [project.id]: "legacy-session" },
      sessionMetadata: { [`${project.id}:legacy-session`]: { title: "Legacy title" } }
    }));
    await writeFile(destinationStatePath, JSON.stringify({
      version: 1,
      projects: [stateProject],
      activeProjectId: stateProject.id,
      selectedSessionIds: { [stateProject.id]: "state-session" },
      sessionMetadata: { [`${stateProject.id}:state-session`]: { pinned: true } }
    }));
    await storage.migrateLegacyState(legacyStatePath, destinationStatePath);
    const migratedState = JSON.parse(await readFile(destinationStatePath, "utf8")) as {
      projects: DesktopProject[];
      activeProjectId?: string;
      selectedSessionIds: Record<string, string>;
      sessionMetadata: Record<string, { title?: string; pinned?: boolean }>;
    };
    assert.deepEqual(migratedState.projects.map((candidate) => candidate.id).sort(), [project.id, stateProject.id].sort());
    assert.equal(migratedState.activeProjectId, stateProject.id);
    assert.equal(migratedState.selectedSessionIds[project.id], "legacy-session");
    assert.equal(migratedState.selectedSessionIds[stateProject.id], "state-session");
    assert.equal(migratedState.sessionMetadata[`${project.id}:legacy-session`]?.title, "Legacy title");
    assert.equal(migratedState.sessionMetadata[`${stateProject.id}:state-session`]?.pinned, true);

    await storage.migrateLegacyConfig([project], configStore);

    // Old desktop builds stored project sessions under userData; open should copy them into the project.
    const desktopProjectRoot = storage.projectDesktopRoot(project);
    await mkdir(desktopProjectRoot, { recursive: true });
    await ensureAgentDirs(desktopProjectRoot);
    const legacySessionBody = `${JSON.stringify({ type: "user_message", content: "keep me" })}\n`;
    await writeFile(sessionFilePath(desktopProjectRoot, "legacy-session"), legacySessionBody);
    await mkdir(path.join(desktopProjectRoot, ".agent", "attachments"), { recursive: true });
    await writeFile(path.join(desktopProjectRoot, ".agent", "attachments", "note.txt"), "attachment migrates with the session\n");

    const dataRoot = await storage.ensureProjectData(project);
    assert.equal(dataRoot, path.resolve(projectRoot));
    assert.equal(await readFile(sessionFilePath(projectRoot, "legacy-session"), "utf8"), legacySessionBody);
    await access(path.join(projectRoot, ".biny", "attachments", "note.txt"));
    await access(path.join(desktopProjectRoot, ".agent", "attachments", "note.txt"));

    const globalRoot = await storage.ensureGlobalData();
    assert.equal(globalRoot, path.join(desktopRoot, "global"));
    await access(path.join(globalRoot, ".biny", "sessions"));

    // 旧项目配置只用于 doctor 提示，启动不会自动迁移或覆盖全局模型配置。
    assert.equal((await configStore.load()).defaultModel, defaultConfig.defaultModel);
    assert.equal((await loadConfigFile(projectRoot)).defaultModel, "deepseek-v4-pro");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function createDesktopTestServices(root: string): Promise<{
  configStore: ReturnType<typeof createFileConfigStore>;
  projects: DesktopProjectService;
  state: DesktopStateStore;
}> {
  const storage = new DesktopUserDataStore(root);
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const testCredentials = new Map<string, string>();
  const configStore = createFileConfigStore(root, {
    globalDir: root,
    credentialStore: {
      persistent: true,
      get: async (account) => testCredentials.get(account),
      set: async (account, value) => { testCredentials.set(account, value); },
      delete: async (account) => { testCredentials.delete(account); }
    }
  });
  // 通过测试凭据存储注入 key，让 runtime 能在没有任何环境变量的机器上初始化；生产实现使用
  // macOS Keychain，配置文件本身不会包含明文 key。
  await configStore.save({
    ...defaultConfig,
    defaultModel: "test-model",
    providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
    models: { "test-model": { provider: "active", model: "test-model" } },
    thinking: { ...defaultConfig.thinking, enabled: false }
  });
  return { configStore, projects: new DesktopProjectService(state, storage, configStore), state };
}

function testProviderCatalogResolution(): void {
  // A relay / self-hosted gateway matches no catalog vendor. It used to fall
  // back to "the first openai-compatible entry", which branded a grok endpoint
  // at ai.td.ee as MiniMax Coding Plan and offered MiniMax M3 as a candidate.
  const relay = { provider: "ai-td-ee", providerType: "openai-compatible" };
  assert.equal(catalogForConnection(relay, "https://ai.td.ee/v1"), undefined);
  const custom = customCatalogEntry({ ...relay, models: [] }, "https://ai.td.ee/v1");
  assert.equal(custom.label, "ai.td.ee");
  assert.equal(custom.iconTone, "compatible");
  assert.equal(custom.models.length, 0);

  // Known vendors still resolve, and the saved endpoint disambiguates two
  // catalog entries that share a hostname.
  assert.equal(catalogForConnection({ provider: "api-x-ai", providerType: "openai-compatible" })?.id, "xai");
  assert.equal(
    catalogForConnection({ provider: "api-z-ai", providerType: "openai-compatible" }, "https://api.z.ai/api/coding/paas/v4")?.id,
    "zai-coding-plan"
  );
  assert.equal(
    catalogForConnection({ provider: "api-z-ai", providerType: "openai-compatible" }, "https://api.z.ai/api/paas/v4")?.id,
    "zai"
  );
}

function testModelChoicesDeduplicateEquivalentAliases(): void {
  const config = structuredClone(defaultConfig);
  config.models["deepseek-deepseek-v4-flash"] = { ...config.models["deepseek-v4-flash"] };
  assert.deepEqual(listModelChoices(config).map((model) => model.alias), ["deepseek-v4-flash", "deepseek-v4-pro"]);
}

function testHistoricalAbortProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "sleep", time: "2026-01-01T00:00:00.000Z" },
    { type: "tool_call", tool: "run_command", args: { command: "sleep 20" }, toolCallId: "tool-1", sequence: 1 },
    { type: "tool_result", tool: "run_command", result: { stdout: "", stderr: "Command interrupted.", exitCode: 1 }, toolCallId: "tool-1", sequence: 1 },
    { type: "error", message: "This operation was aborted" }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.status, "aborted");
  assert.equal(timeline[0]?.tools[0]?.status, "aborted");
}

function testHistoricalUsageProjection(): void {
  const events: SessionEvent[] = [
    { type: "user_message", content: "hello" },
    {
      type: "assistant_message",
      content: "hi",
      usage: {
        operation: "agent",
        modelAlias: "primary",
        provider: "openai",
        model: "gpt-test",
        totalTokens: 42,
        pricingKnown: false
      }
    }
  ];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.model?.alias, "primary");
  assert.equal(timeline[0]?.model?.label, "openai/gpt-test");
  assert.equal(timeline[0]?.usage?.totalTokens, 42);
}

function testHistoricalToolProjection(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "read" },
    { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "tool" },
    { type: "tool_result", tool: "read_file", result: { path: "src/index.ts", content: "hello" }, toolCallId: "tool" }
  ], []);
  assert.equal(timeline[0]?.tools[0]?.path, "src/index.ts");
  assert.deepEqual(timeline[0]?.tools[0]?.display, { kind: "file_io", operation: "read", path: "src/index.ts" });
}

function testWebSearchProjection(): void {
  const searchResult = {
    query: "Chicago weather",
    provider: "tavily",
    results: [
      { title: "Chicago Forecast", url: "https://www.weather.gov/chicago", snippet: "Official forecast.", favicon: "https://www.weather.gov/favicon.ico" },
      { title: "HTTP favicon", url: "https://example.com/http-favicon", favicon: "http://tracker.example.com/pixel.ico" },
      { title: "Broken entry", url: "not-a-url" },
      { title: "FTP entry", url: "ftp://example.com/file" }
    ],
    fetchedAt: "2026-01-01T00:00:03.000Z"
  };
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "查天气" },
    { type: "tool_call", tool: "web_search", args: { query: "Chicago weather" }, toolCallId: "search" },
    { type: "tool_result", tool: "web_search", result: searchResult, toolCallId: "search" }
  ], []);
  const tool = timeline[0]?.tools[0];
  assert.equal(tool?.status, "success");
  assert.deepEqual(tool?.display, { kind: "generic", summary: "Chicago weather", detail: { query: "Chicago weather" } });

  const view = projectWebSearchView(tool?.args, tool?.result);
  assert.equal(view.query, "Chicago weather");
  assert.equal(view.providerLabel, "Tavily");
  assert.equal(view.fetchedAt, "2026-01-01T00:00:03.000Z");
  // 非法 URL 与非 http(s) 协议的结果不进入视图。
  assert.equal(view.results.length, 2);
  assert.equal(view.results[0]?.domain, "weather.gov");
  assert.equal(view.results[0]?.fallbackLetter, "W");
  assert.deepEqual(view.results[0]?.faviconCandidates, [
    "https://www.weather.gov/favicon.ico",
    "https://icons.duckduckgo.com/ip3/www.weather.gov.ico",
    "https://www.google.com/s2/favicons?domain=www.weather.gov&sz=64"
  ]);
  // 明文 http favicon 不进入回退链，直接落到图标服务。
  assert.deepEqual(view.results[1]?.faviconCandidates, [
    "https://icons.duckduckgo.com/ip3/example.com.ico",
    "https://www.google.com/s2/favicons?domain=example.com&sz=64"
  ]);

  // 运行中（尚无结果）时只有查询词，provider 未知。
  const runningView = projectWebSearchView({ query: "Chicago weather" }, undefined);
  assert.equal(runningView.query, "Chicago weather");
  assert.equal(runningView.providerLabel, undefined);
  assert.equal(runningView.results.length, 0);
}

function testHistoricalReasoningAndSkillProjection(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "explain", skills: [".agent/skills/programmatic-tools/SKILL.md"], time: "2026-01-01T00:00:00.000Z" },
    { type: "tool_call", tool: "run_command", args: { command: "pwd" }, reasoningContent: "先确认当前工作目录。", time: "2026-01-01T00:00:01.000Z" },
    { type: "assistant_message", content: "done", reasoningContent: "然后整理结果。", time: "2026-01-01T00:00:02.512Z" }
  ], []);
  assert.deepEqual(timeline[0]?.skills, ["programmatic-tools"]);
  assert.equal(timeline[0]?.reasoning, "先确认当前工作目录。\n\n然后整理结果。");
  assert.equal(timeline[0]?.durationMs, 2_512);
}

function testExecutionTimelineKeepsReasoningAndToolsInOrder(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "inspect and test" },
    { type: "tool_call", tool: "read_file", args: { path: "src/index.ts" }, toolCallId: "read", assistantContent: "先检查入口。", reasoningContent: "先确认入口文件。" },
    { type: "tool_result", tool: "read_file", result: { path: "src/index.ts" }, toolCallId: "read" },
    { type: "tool_call", tool: "run_command", args: { command: "pnpm test" }, toolCallId: "test", assistantContent: "再运行测试。", reasoningContent: "根据入口继续验证。" },
    { type: "tool_result", tool: "run_command", result: { exitCode: 0 }, toolCallId: "test" },
    { type: "assistant_message", content: "完成。", reasoningContent: "最后整理结果。" }
  ], []);
  const turn = timeline[0];
  assert.deepEqual(turn?.steps.map((step) => step.kind), ["reasoning", "assistant", "tool", "reasoning", "assistant", "tool", "reasoning", "assistant"]);
  assert.equal(turn?.steps[0]?.kind === "reasoning" ? turn.steps[0].content : undefined, "先确认入口文件。");
  assert.equal(turn?.steps[2]?.kind === "tool" ? turn.steps[2].tool.id : undefined, "read");
  assert.equal(turn?.steps[5]?.kind === "tool" ? turn.steps[5].tool.id : undefined, "test");
  assert.equal(turn?.steps[6]?.kind === "reasoning" ? turn.steps[6].content : undefined, "最后整理结果。");
}

function testLiveExecutionTimelineKeepsReasoningAndToolsInOrder(): void {
  const base = { sessionId: "session", runId: "ordered-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "inspect and test" },
    { ...base, type: "run.started", messageId: "message", input: "inspect and test", mode: "chat", model: { alias: "test", provider: "test", label: "test/model", reasoning: "High" }, skills: [] },
    { ...base, type: "reasoning.started", messageId: "message", status: "正在分析任务" },
    { ...base, timestamp: "2026-01-01T00:00:01.000Z", type: "reasoning.delta", messageId: "message", content: "先检查入口。" },
    { ...base, timestamp: "2026-01-01T00:00:02.000Z", type: "reasoning.completed", messageId: "message", status: "分析完成" },
    { ...base, timestamp: "2026-01-01T00:00:03.000Z", type: "tool.started", toolCallId: "read", tool: "read_file", args: { path: "src/index.ts" } },
    { ...base, timestamp: "2026-01-01T00:00:04.000Z", type: "tool.completed", toolCallId: "read", tool: "read_file", result: {}, durationMs: 1_000 },
    { ...base, timestamp: "2026-01-01T00:00:05.000Z", type: "reasoning.started", messageId: "message", status: "正在验证" },
    { ...base, timestamp: "2026-01-01T00:00:06.000Z", type: "reasoning.delta", messageId: "message", content: "再运行测试。" },
    { ...base, timestamp: "2026-01-01T00:00:07.000Z", type: "reasoning.completed", messageId: "message", status: "分析完成" },
    { ...base, timestamp: "2026-01-01T00:00:08.000Z", type: "tool.started", toolCallId: "test", tool: "run_command", args: { command: "pnpm test" } },
    { ...base, timestamp: "2026-01-01T00:00:09.000Z", type: "tool.completed", toolCallId: "test", tool: "run_command", result: {}, durationMs: 1_000 },
    { ...base, timestamp: "2026-01-01T00:00:10.000Z", type: "assistant.delta", messageId: "message", content: "完成。" },
    { ...base, timestamp: "2026-01-01T00:00:11.000Z", type: "assistant.completed", messageId: "message", content: "完成。" },
    { ...base, timestamp: "2026-01-01T00:00:12.000Z", type: "run.completed", durationMs: 12_000 }
  ]);
  const turn = timeline[0];
  assert.deepEqual(turn?.steps.map((step) => step.kind), ["reasoning", "tool", "reasoning", "tool", "assistant"]);
  assert.deepEqual(turn?.steps.filter((step) => step.kind === "reasoning").map((step) => step.content), ["先检查入口。", "再运行测试。"]);
  assert.deepEqual(turn?.steps.filter((step) => step.kind === "tool").map((step) => step.tool.id), ["read", "test"]);
}

function testLiveAssistantCompletionDoesNotDuplicateDelta(): void {
  const base = { sessionId: "session", runId: "duplicate-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "停止进程" },
    { ...base, type: "assistant.delta", messageId: "message", content: "正文" },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "list_processes", args: {} },
    { ...base, type: "tool.completed", toolCallId: "tool", tool: "list_processes", result: {}, durationMs: 10 },
    { ...base, type: "assistant.completed", messageId: "message", content: "正文" },
    { ...base, type: "run.completed", durationMs: 20 }
  ]);
  const turn = timeline[0];
  const assistantSteps = turn?.steps.filter((step) => step.kind === "assistant") ?? [];
  assert.equal(assistantSteps.length, 1);
  assert.equal(assistantSteps[0]?.kind === "assistant" ? assistantSteps[0].content : undefined, "正文");
  assert.equal(turn?.assistant, "正文");
}

function testVerifierPromptIsNotRenderedAsUserMessage(): void {
  const internalPrompt = [
    "关掉它吧",
    "",
    "This is a verifier-driven task. Complete the objective and satisfy every acceptance criterion below.",
    "Task contract type: conversation.",
    "Constraints:\n- Keep all work inside the workspace.",
    "Current plan:\n- [pending] Produce the requested answer or analysis. (required)",
    "Do not claim completion until the workspace and the required checks are actually in a passing state."
  ].join("\n");
  const base = { sessionId: "session", runId: "verifier-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const historical = buildSessionTimeline([{ type: "user_message", content: internalPrompt }], []);
  assert.equal(historical[0]?.user, "关掉它吧");

  const live = buildSessionTimeline([], [{ ...base, type: "message.user", messageId: "message", content: internalPrompt }]);
  assert.equal(live[0]?.user, "关掉它吧");
}

function testHistoricalPrefixKeepsUnpersistedDuplicatePrompt(): void {
  const liveTimestamp = "2026-01-01T00:00:10.000Z";
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "同一个问题", time: "2026-01-01T00:00:00.000Z" },
    { type: "assistant_message", content: "历史回复", time: "2026-01-01T00:00:01.000Z" }
  ], [
    { sessionId: "session", runId: "run", timestamp: liveTimestamp, type: "message.user", messageId: "message", content: "同一个问题" }
  ]);
  assert.deepEqual(timeline.map((turn) => turn.user), ["同一个问题", "同一个问题"]);
  assert.equal(timeline[0]?.assistant, "历史回复");
}

function testHistoricalEmptyAssistantDoesNotEraseReply(): void {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "完成任务" },
    { type: "assistant_message", content: "任务已完成" },
    { type: "assistant_message", content: "", relatedUsage: [] }
  ], []);
  assert.equal(timeline[0]?.assistant, "任务已完成");
}

function testChangedFileProjection(): void {
  const base = { sessionId: "session", runId: "write-run", timestamp: "2026-01-01T00:00:00.000Z" };
  const started = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "write" },
    { ...base, type: "tool.started", toolCallId: "write-tool", tool: "write_file", args: { path: "hello.py" }, display: { kind: "file_io", operation: "write", path: "hello.py" } }
  ]);
  assert.equal(started[0]?.tools[0]?.path, "hello.py");
  assert.deepEqual(listChangedFiles(started[0]!), [{ path: "hello.py", operation: "write", status: "writing" }]);

  const completed = buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "message", content: "write" },
    { ...base, type: "tool.started", toolCallId: "write-tool", tool: "write_file", args: { path: "hello.py" }, display: { kind: "file_io", operation: "write", path: "hello.py" } },
    { ...base, type: "tool.completed", toolCallId: "write-tool", tool: "write_file", result: { path: "hello.py" }, durationMs: 10 },
    { ...base, type: "file.changed", toolCallId: "write-tool", path: "hello.py", operation: "write" }
  ]);
  assert.deepEqual(listChangedFiles(completed[0]!), [{ path: "hello.py", operation: "write", status: "completed" }]);

  const edited = buildSessionTimeline([], [
    { ...base, runId: "edit-run", type: "message.user", messageId: "edit-message", content: "edit" },
    { ...base, runId: "edit-run", type: "tool.started", toolCallId: "edit-tool", tool: "edit_file", args: { path: "hello.py" }, display: { kind: "file_io", operation: "edit", path: "hello.py" } },
    { ...base, runId: "edit-run", type: "tool.completed", toolCallId: "edit-tool", tool: "edit_file", result: { path: "hello.py" }, durationMs: 10 }
  ]);
  assert.deepEqual(listTimelineFiles([completed[0]!, edited[0]!]), [{ path: "hello.py", operation: "edit", status: "completed" }]);
}

function testLiveTimelineProjection(): void {
  const base = { sessionId: "session", runId: "run", timestamp: "2026-01-01T00:00:00.000Z" };
  const live: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "message", content: "show diff" },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "git_diff", args: {} },
    { ...base, type: "diff.created", toolCallId: "tool", diff: "diff --git a/a.ts b/a.ts\n+const a = 1;" },
    { ...base, type: "tool.completed", toolCallId: "tool", tool: "git_diff", result: {}, durationMs: 20 },
    { ...base, type: "assistant.completed", messageId: "message", content: "done" },
    { ...base, type: "run.completed", durationMs: 30 }
  ];
  const timeline = buildSessionTimeline([], live);
  assert.equal(timeline[0]?.assistant, "done");
  assert.equal(timeline[0]?.tools[0]?.diff?.includes("a.ts"), true);
  assert.equal(timeline[0]?.status, "completed");

  const failedCommand = buildSessionTimeline([], [
    { ...base, runId: "failed-command", type: "message.user", messageId: "command-message", content: "run" },
    { ...base, runId: "failed-command", type: "tool.started", toolCallId: "command", tool: "run_command", args: { command: "false" } },
    { ...base, runId: "failed-command", type: "tool.completed", toolCallId: "command", tool: "run_command", result: { exitCode: 1 }, durationMs: 8 },
    { ...base, runId: "failed-command", type: "command.completed", toolCallId: "command", command: "false", exitCode: 1, durationMs: 8 }
  ]);
  assert.equal(failedCommand[0]?.tools[0]?.status, "failed");

  const typedFailure = buildSessionTimeline([], [
    { ...base, runId: "typed-failure", type: "message.user", messageId: "typed-message", content: "run" },
    { ...base, runId: "typed-failure", type: "tool.started", toolCallId: "typed-command", tool: "run_command", args: { command: "false" } },
    { ...base, runId: "typed-failure", type: "command.failed", toolCallId: "typed-command", command: "false", status: "failed", exitCode: 1, error: "Command exited with code 1.", durationMs: 8 },
    { ...base, runId: "typed-failure", type: "run.incomplete", durationMs: 30, reason: "Step limit reached.", stopReason: "step_limit", finishReason: "tool-calls", steps: 8 }
  ]);
  assert.equal(typedFailure[0]?.tools[0]?.status, "failed");
  assert.equal(typedFailure[0]?.status, "incomplete");
  assert.equal(typedFailure[0]?.error, "Step limit reached.");
}

function testLiveReasoningAndSkillProjection(): void {
  const live: AgentHostEvent[] = [
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:00.000Z", type: "message.user", messageId: "message", content: "explain" },
    {
      sessionId: "session",
      runId: "reasoning-run",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run.started",
      messageId: "message",
      input: "explain",
      mode: "chat",
      model: { alias: "test", provider: "test", label: "test/model", reasoning: "High" },
      skills: [".agent/skills/programmatic-tools/SKILL.md"]
    },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:01.000Z", type: "reasoning.started", messageId: "message", status: "正在分析任务" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:02.512Z", type: "reasoning.delta", messageId: "message", content: "先拆分问题。" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:02.512Z", type: "reasoning.completed", messageId: "message", status: "分析完成" },
    { sessionId: "session", runId: "reasoning-run", timestamp: "2026-01-01T00:00:03.000Z", type: "run.completed", durationMs: 3_000 }
  ];
  const timeline = buildSessionTimeline([], live);
  assert.deepEqual(timeline[0]?.skills, ["programmatic-tools"]);
  assert.equal(timeline[0]?.reasoning, "先拆分问题。");
  assert.equal(timeline[0]?.reasoningDurationMs, 1_512);
}

function testReasoningDetailDoesNotUseCompletionStatusAsContent(): void {
  assert.equal(reasoningDetailText({ content: "  先检查入口。  " }), "先检查入口。");
  assert.equal(reasoningDetailText({ content: "" }), "该模型未返回可展示的思考内容");
}

function testDesktopNavigationHistory(): void {
  const first = { projectId: "project", sessionId: "first" };
  const second = { projectId: "project", sessionId: "second" };
  const draft = { projectId: "project", sessionId: undefined };
  let state = createNavigationState();
  state = pushNavigation(state, first);
  state = pushNavigation(state, second);
  assert.equal(canNavigateBack(state), true);
  assert.equal(canNavigateForward(state), false);

  const back = moveNavigation(state, -1);
  assert.deepEqual(back.target, first);
  state = back.state;
  state = pushNavigation(state, draft);
  assert.equal(canNavigateForward(state), false);
  assert.deepEqual(state.entries, [first, draft]);
  state = replaceNavigation(state, second);
  assert.deepEqual(state.entries, [first, second]);
  assert.deepEqual(moveNavigation(state, 1).target, undefined);
}

function fakeCommandRuntime(requireFullYes = false): CommandRuntime {
  const info: AgentSessionInfo = {
    workspaceRoot: "/tmp/project",
    sessionId: "session-1",
    sessionFile: "/tmp/project/.biny/sessions/session-1.jsonl",
    provider: "test",
    modelLabel: "test/model",
    reasoningLabel: "Off",
    modelAlias: "test",
    thinking: "off"
  };
  const context: ContextStatus = {
    loadedInstructions: [],
    instructionBytes: 0,
    instructionCapBytes: 10_000,
    snapshotRefreshedAt: undefined,
    snapshotDirty: false,
    repoMapRefreshedAt: undefined,
    repoMapDirty: false,
    repoMapEntries: 0,
    activePaths: [],
    recentActivity: { paths: [], summaries: [] },
    compaction: { summaryPresent: false, compactedMessages: 0, lastCompactedAt: undefined },
    budget: { maxTokens: 24_000, usedTokens: 10, omitted: [], autoCompacted: false, source: "estimated", measuredAt: undefined },
    memoryEnabled: false,
    memoryTopics: []
  };
  const request = {
    toolCallId: "tool-1",
    tool: "write_file",
    title: "Allow write",
    details: "Write a file",
    requireFullYes,
    actionType: "write",
    riskLevel: "medium"
  };
  const agent = {
    getInfo: () => info,
    getPermissionMode: () => "ask" as const,
    setPermissionMode: async () => undefined,
    listModels: () => [],
    switchModel: async () => ({ modelAlias: "test", provider: "test", modelLabel: "test/model", reasoningLabel: "Off", thinking: "off" as const }),
    async *run(input: string, options: AgentRunOptions): AsyncGenerator<AgentSessionEvent> {
      yield { type: "status", status: "thinking" };
      if (input === "cancel") {
        if (!options.abortSignal?.aborted) {
          await new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        throw new Error("aborted");
      }
      if (input === "secret-event-error") {
        yield { type: "error", message: "provider token=opaque-live-run-secret" };
        return;
      }
      if (input === "secret-thrown-error") throw new Error("provider password=opaque-live-run-secret");
      const secretProbe = input === "secret";
      if (secretProbe) {
        yield {
          type: "sdk",
          part: { type: "reasoning-delta", id: "reasoning", text: "token=opaque-live-tool-secret" } as AgentSessionEvent & never
        };
      }
      yield {
        type: "tool-started",
        toolCallId: "tool-1",
        tool: "write_file",
        args: {
          path: "a.ts",
          apiKey: secretProbe ? "opaque-live-tool-secret" : undefined,
          webhookSecret: secretProbe ? "opaque-live-tool-secret" : undefined
        },
        display: {
          kind: "file_io",
          operation: "write",
          path: "a.ts",
          content: secretProbe ? "apiKey=opaque-live-tool-secret" : undefined
        }
      };
      const result = await options.confirmPermission?.(request as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0]);
      yield { type: "permission-result", toolCallId: "tool-1", request: request as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0], result: result ?? { approved: false } };
      const output = input === "stale"
        ? { status: "permission_required", approved: false, reason: "The target changed after approval." }
        : secretProbe
          ? { path: "a.ts", token: "opaque-live-tool-secret", diffPreview: "+ apiKey=opaque-live-tool-secret", safe: "visible" }
          : { path: "a.ts" };
      yield { type: "sdk", part: { type: "tool-result", toolCallId: "tool-1", toolName: "write_file", output } as AgentSessionEvent & never };
      yield {
        type: "sdk",
        part: {
          type: "text-delta",
          id: "text",
          text: secretProbe ? "password=opaque-live-tool-secret" : "done"
        } as AgentSessionEvent & never
      };
      const content = secretProbe ? "Authorization: Bearer opaque-live-tool-secret" : "done";
      yield {
        type: "done",
        content,
        outcome: {
          status: "completed",
          stopReason: "model_stop",
          finishReason: "stop",
          steps: 1,
          output: content
        }
      };
    },
    contextStatus: async () => context,
    recordError: () => undefined,
    close: async () => undefined
  };
  return {
    agent,
    getSubagentInfo: () => ({ modelAlias: "test", provider: "test", modelLabel: "test/model", reasoningLabel: "Off", thinking: "off" as const }),
    runSubagentTask: async (task: string) => {
      if (task === "secret-subagent-failure") throw new Error("subagent apiKey=opaque-live-run-secret");
      return `subagent:${task}`;
    },
    setSubagentParentRunId: () => undefined,
    cancelSubagentTasks: () => undefined,
    close: async () => undefined
  } as unknown as CommandRuntime;
}

function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    persistent: true,
    get: async (account) => values.get(account),
    set: async (account, value) => {
      values.set(account, value);
    },
    delete: async (account) => {
      values.delete(account);
    }
  };
}
