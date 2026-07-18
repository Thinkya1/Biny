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
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { saveConfig } from "../src/config/loader.js";
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
import type { TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";
import { highlightWorkspaceFile } from "../src/desktop/renderer/src/syntaxHighlight.js";
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
testWorkspaceFileMarkers();
await testFilePanelSizing();
await testDesktopModelConfiguration();
await testDesktopCredentialsAreSeparated();
await testDesktopRequiresModelConfiguration();
await testLegacyDesktopDataMigration();
testModelChoicesDeduplicateEquivalentAliases();
testHistoricalAbortProjection();
testHistoricalUsageProjection();
testHistoricalToolProjection();
testHistoricalReasoningAndSkillProjection();
testHistoricalPrefixKeepsUnpersistedDuplicatePrompt();
testHistoricalEmptyAssistantDoesNotEraseReply();
testChangedFileProjection();
testLiveTimelineProjection();
testLiveReasoningAndSkillProjection();
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
  assert.equal(runtime.getSnapshot().pendingPermission?.requestId, permission.requestId);
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
      supportsThinking: false
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
    await access(path.join(desktopRoot, "projects", project.id, ".agent", "sessions"));
    await assert.rejects(access(path.join(workspaceRoot, "agent.config.json")));
    await assert.rejects(access(path.join(workspaceRoot, ".agent")));
    await agents.closeAll();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(desktopRoot, { recursive: true, force: true });
  }
}

async function testDesktopCredentialsAreSeparated(): Promise<void> {
  const desktopRoot = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-credentials-"));
  try {
    const store = new DesktopConfigStore(desktopRoot, {
      isAvailable: () => true,
      encrypt: (value) => `encrypted:${Buffer.from(value).toString("base64")}`,
      decrypt: (value) => Buffer.from(value.slice("encrypted:".length), "base64").toString("utf8")
    });
    const config = structuredClone(defaultConfig);
    config.providers.deepseek!.apiKey = "desktop-secret";
    await store.save(config);
    const [settings, credentials] = await Promise.all([
      readFile(path.join(desktopRoot, "agent.config.json"), "utf8"),
      readFile(path.join(desktopRoot, "credentials.json"), "utf8")
    ]);
    assert.doesNotMatch(settings, /desktop-secret/);
    assert.doesNotMatch(credentials, /desktop-secret/);
    assert.equal((await store.load()).providers.deepseek?.apiKey, "desktop-secret");
  } finally {
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
    await saveConfig(projectRoot, config);
    await ensureAgentDirs(projectRoot);
    await writeFile(sessionFilePath(projectRoot, "legacy-session"), `${JSON.stringify({ type: "user_message", content: "keep me" })}\n`);

    const storage = new DesktopUserDataStore(desktopRoot);
    await storage.initialize();
    const configStore = new DesktopConfigStore(desktopRoot, {
      isAvailable: () => true,
      encrypt: (value) => value,
      decrypt: (value) => value
    });
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
    const projectDataRoot = storage.projectRoot(project);
    await mkdir(path.join(projectDataRoot, ".agent"), { recursive: true });
    await storage.ensureProjectData(project);

    assert.equal((await configStore.load()).defaultModel, "deepseek-v4-pro");
    assert.equal(await readFile(sessionFilePath(projectDataRoot, "legacy-session"), "utf8"), await readFile(sessionFilePath(projectRoot, "legacy-session"), "utf8"));
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
  const configStore = createFileConfigStore(root);
  return { configStore, projects: new DesktopProjectService(state, storage, configStore), state };
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
    sessionFile: "/tmp/project/.agent/sessions/session-1.jsonl",
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
    async *runSdk(input: string, options: AgentRunOptions): AsyncGenerator<AgentSessionEvent> {
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
      yield { type: "done", content: secretProbe ? "Authorization: Bearer opaque-live-tool-secret" : "done" };
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
