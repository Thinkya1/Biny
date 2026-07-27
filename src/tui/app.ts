/**
 * TUI 应用外壳。
 *
 * 负责把 pi-tui 的渲染循环、TUI runtime、reducer 状态和各展示组件串起来：
 * 组装布局、订阅运行时事件、分发 slash command、处理全局键位。
 * 具体的上下文、会话、工具逻辑仍在 runtime 层，这里不直接执行工具。
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  Spacer,
  TUI,
  type OverlayHandle,
  type SelectItem
} from "@earendil-works/pi-tui";
import { formatPermissionModeChanged } from "../permission/commands.js";
import type { PermissionMode } from "../permission/PermissionManager.js";
import { parseThinkingSelection, type ThinkingSelection } from "../llm/ModelManager.js";
import { formatSubagentTaskReport } from "../runtime/subagentTaskReport.js";
import { formatSubagentAgentList } from "../extensions/report.js";
import type { SessionSummary } from "../session/events.js";
import { FooterComponent, ShortcutsBarComponent, StatusIndicatorComponent, WelcomeComponent } from "./components/chrome.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "./components/dialogs.js";
import { ThinkingComponent, ToolExecutionComponent } from "./components/messages.js";
import { TranscriptView } from "./components/transcriptView.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
import { permissionModeOptions } from "./permissionModeOptions.js";
import { createTuiRuntime, type TuiRuntime } from "./runtime/createTuiRuntime.js";
import { readGitBranch } from "./runtime/gitBranch.js";
import { sessionEventsToTranscript } from "./sessionTranscript.js";
import { TUI_SLASH_COMMANDS } from "./slashCommands.js";
import { modelThinkingOptions } from "./modelOptions.js";
import { createInitialTuiState, tuiReducer } from "./state.js";
import { editorTheme, theme } from "./theme/index.js";
import { foldableTranscriptItems, latestExpandableTranscript } from "./transcriptText.js";
import type { TuiState } from "./types.js";

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

export class BinyTui {
  private readonly ui: TUI;
  private readonly workspaceRoot: string;
  private readonly version: string | undefined;

  private state: TuiState;
  private runtime: TuiRuntime | undefined;

  private readonly headerContainer = new Container();
  private readonly chatContainer = new TranscriptView();
  private readonly editorContainer = new Container();
  private readonly status: StatusIndicatorComponent;
  private readonly footer: FooterComponent;
  private readonly shortcuts = new ShortcutsBarComponent();
  private readonly editor: Editor;

  private mode: "chat" | "plan" = "chat";
  private permissionMode: PermissionMode = "ask";
  private thinking: ThinkingSelection = "off";
  private gitBranch: string | undefined;
  private contextUsage: { usedTokens?: number; maxTokens?: number; source?: "estimated" | "provider" } = {};
  private overlay: OverlayHandle | undefined;
  private permissionDialog: PermissionDialog | undefined;
  private exiting = false;
  private exitSummary: TuiExitSummary | undefined;
  private unsubscribe: (() => void) | undefined;
  private resolveExit: (() => void) | undefined;

  constructor(ui: TUI, workspaceRoot: string, version?: string) {
    this.ui = ui;
    this.workspaceRoot = workspaceRoot;
    this.version = version;
    this.state = createInitialTuiState(workspaceRoot);
    this.status = new StatusIndicatorComponent(ui);
    this.footer = new FooterComponent(this.footerData());
    this.editor = new Editor(ui, editorTheme(), { paddingX: 1 });
    this.editorContainer.addChild(this.editor);
  }

  /** 启动界面并等待退出。 */
  async run(): Promise<TuiExitSummary | undefined> {
    this.ui.addChild(this.headerContainer);
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.status);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.footer);
    this.ui.addChild(this.shortcuts);

    this.headerContainer.addChild(new Spacer(1));
    this.headerContainer.addChild(new WelcomeComponent(this.workspaceRoot, this.version));

    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
    this.ui.setFocus(this.editor);
    this.ui.addInputListener((data) => this.handleGlobalKey(data));
    this.ui.start();

    await this.startRuntime();
    this.refreshChrome();

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    return this.exitSummary;
  }

  private async startRuntime(): Promise<void> {
    try {
      const runtime = await createTuiRuntime(this.workspaceRoot);
      this.runtime = runtime;
      const info = runtime.getInfo();
      this.permissionMode = runtime.getPermissionMode();
      this.thinking = info.thinking;
      // 补全器要的是不带斜杠的命令名，它自己会补上 `/`；带斜杠会补出 `//resume`。
      this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
        TUI_SLASH_COMMANDS.map((command) => ({
          name: command.name.replace(/^\//, ""),
          description: command.description
        })),
        info.workspaceRoot
      ));
      this.editor.borderColor = theme.thinkingBorder(this.thinking);

      void readGitBranch(info.workspaceRoot).then((branch) => {
        this.gitBranch = branch;
        this.refreshChrome();
      });
      void loadInputHistory(info.workspaceRoot)
        .then((history) => {
          for (const entry of history.slice(-100)) this.editor.addToHistory(entry);
        })
        .catch((error) => this.notify(`读取输入历史失败：${describeError(error)}`));

      this.unsubscribe = runtime.subscribe((event) => {
        this.dispatch(event);
        if (event.type === "session.completed" || event.type === "session.incomplete" || event.type === "session.error") {
          void this.refreshContextUsage();
        }
      });
      this.dispatch({
        type: "session.started",
        sessionId: info.sessionId,
        sessionFile: info.sessionFile,
        cwd: info.workspaceRoot,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
      void this.refreshContextUsage();
    } catch (error) {
      this.notify(`TUI startup failed: ${describeError(error)}`);
    }
  }

  private dispatch(event: Parameters<typeof tuiReducer>[1]): void {
    this.state = tuiReducer(this.state, event);
    this.syncPermissionDialog();
    this.chatContainer.sync(this.state.transcript);
    this.refreshChrome();
  }

  private notify(content: string): void {
    this.dispatch({ type: "system.message", content });
  }

  private refreshChrome(): void {
    this.status.setState(this.state.status, this.state.queuedCount);
    this.shortcuts.setState(this.state.status, this.mode);
    this.footer.setData(this.footerData());
    this.ui.requestRender();
  }

  private footerData(): Parameters<FooterComponent["setData"]>[0] {
    return {
      cwd: this.state.cwd,
      sessionId: this.state.sessionId,
      viewingSessionId: this.state.viewingSessionId,
      gitBranch: this.gitBranch,
      modelLabel: this.state.modelLabel,
      thinkingLabel: this.state.reasoningLabel,
      permissionMode: this.permissionMode,
      mode: this.mode,
      contextUsedTokens: this.contextUsage.usedTokens,
      contextMaxTokens: this.contextUsage.maxTokens,
      contextSource: this.contextUsage.source
    };
  }

  private async refreshContextUsage(): Promise<void> {
    if (!this.runtime) return;
    try {
      const context = await this.runtime.contextStatus();
      // 百分比按模型自身的上下文窗口算；没有窗口信息时才退回输入预算。
      this.contextUsage = {
        usedTokens: context.budget.usedTokens,
        maxTokens: context.budget.contextWindow ?? context.budget.maxTokens,
        source: context.budget.source
      };
      this.refreshChrome();
    } catch {
      // Footer telemetry is best effort and must never interrupt the TUI.
    }
  }

  // ---------------------------------------------------------------- 输入分发

  private async submit(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    this.editor.setText("");
    this.editor.addToHistory(value);
    void appendInputHistory(this.workspaceRoot, value)
      .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));

    if (value.startsWith("/")) {
      try {
        await this.handleSlashCommand(value);
      } catch (error) {
        this.showTextViewer("Command Error", describeError(error));
      }
      return;
    }

    const runtime = this.runtime;
    if (!runtime) return;
    try {
      await runtime.sendPrompt(value, this.mode);
    } catch (error) {
      this.dispatch({ type: "error.message", message: describeError(error) });
    } finally {
      await this.refreshContextUsage();
    }
  }

  /** 全局键位。返回 `{consume:true}` 表示不再投递给焦点组件。 */
  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    const busy = this.state.status === "thinking"
      || this.state.status === "running"
      || this.state.status === "waiting_permission";

    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        this.runtime?.cancelCurrentTurn();
        return { consume: true };
      }
      void this.exit();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.overlay) return undefined;
      if (busy) {
        this.runtime?.cancelCurrentTurn();
        return { consume: true };
      }
      return undefined;
    }
    if (this.overlay) return undefined;
    if (matchesKey(data, "shift+tab")) {
      this.mode = this.mode === "plan" ? "chat" : "plan";
      this.refreshChrome();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+e")) {
      this.toggleLatestFoldable();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      this.showLatestDetails();
      return { consume: true };
    }
    return undefined;
  }

  private toggleLatestFoldable(): void {
    const foldables = foldableTranscriptItems(this.state.transcript);
    const latest = foldables[foldables.length - 1];
    if (!latest) return;
    const component = this.chatContainer.componentFor(latest.id);
    if (component instanceof ThinkingComponent) component.setCollapsed(!component.isCollapsed());
    else if (component instanceof ToolExecutionComponent) component.setExpanded(!component.isExpanded());
    this.ui.requestRender();
  }

  private showLatestDetails(): void {
    const expandable = latestExpandableTranscript(this.state.transcript);
    if (expandable) this.showTextViewer(expandable.title, expandable.content);
  }

  // ---------------------------------------------------------------- 弹层

  private showOverlay(component: Container, options?: { maxHeight?: `${number}%` }): void {
    this.closeOverlay();
    this.overlay = this.ui.showOverlay(component, {
      width: "100%",
      anchor: "bottom-center",
      maxHeight: options?.maxHeight ?? "70%"
    });
    this.overlay.focus();
  }

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.permissionDialog = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private showTextViewer(title: string, content: string): void {
    const rows = Math.max(4, Math.floor(this.ui.terminal.rows * 0.6));
    const viewer = new TextViewerDialog(title, content, rows, () => this.closeOverlay());
    this.showOverlay(viewer);
  }

  private showSelect(options: {
    title: string;
    items: SelectItem[];
    selectedIndex?: number;
    hint?: string;
    onSelect: (item: SelectItem) => void;
  }): void {
    const dialog = new SelectDialog({
      title: options.title,
      items: options.items,
      selectedIndex: options.selectedIndex,
      hint: options.hint,
      maxVisible: Math.max(4, Math.floor(this.ui.terminal.rows * 0.4)),
      onSelect: (item) => {
        this.closeOverlay();
        options.onSelect(item);
      },
      onCancel: () => this.closeOverlay()
    });
    this.showOverlay(dialog);
  }

  /** 权限请求进出时同步弹层，避免请求切换后还留着上一份确认状态。 */
  private syncPermissionDialog(): void {
    const request = this.state.permission;
    if (!request) {
      if (this.permissionDialog) this.closeOverlay();
      return;
    }
    if (this.permissionDialog) {
      this.permissionDialog.setRequest(request);
      this.permissionDialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
      return;
    }
    const dialog = new PermissionDialog(
      request,
      (choice) => {
        this.closeOverlay();
        this.runtime?.answerPermission(choice);
      },
      () => {
        this.dispatch({ type: "permission.details.toggled" });
      }
    );
    dialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
    this.permissionDialog = dialog;
    this.showOverlay(dialog);
  }

  // ---------------------------------------------------------------- slash

  private async handleSlashCommand(value: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    // 容忍多打的斜杠：`//resume` 只可能是想写 `/resume`。
    const [command = "", ...args] = value.trim().replace(/^\/+/, "/").split(/\s+/);

    if (command === "/" || command === "/help") {
      this.showSelect({
        title: "Commands",
        items: TUI_SLASH_COMMANDS.map((entry) => ({
          value: entry.name,
          label: entry.name,
          description: entry.description
        })),
        hint: "↑↓ navigate · enter insert · esc cancel",
        onSelect: (item) => {
          this.editor.setText(`${item.value} `);
          this.ui.requestRender();
        }
      });
      return;
    }

    if (command === "/exit" || command === "/quit") {
      await this.exit();
      return;
    }

    if (command === "/clear") {
      this.dispatch({ type: "transcript.replaced", items: [] });
      this.chatContainer.reset();
      this.ui.requestRender();
      return;
    }

    if (command === "/context") {
      this.showTextViewer("Context", await runtime.contextReport());
      return;
    }

    if (command === "/usage") {
      this.showTextViewer("Usage", runtime.usageReport());
      return;
    }

    if (command === "/status") {
      this.showTextViewer("Status", runtime.extensionReport());
      return;
    }

    if (command === "/mcp" || command === "/skills" || command === "/plugins") {
      const section = command.slice(1) as "mcp" | "skills" | "plugins";
      const title = section === "mcp" ? "MCP" : section.charAt(0).toUpperCase() + section.slice(1);
      this.showTextViewer(title, runtime.extensionReport(section).replace(new RegExp(`^${title}\\n`), ""));
      return;
    }

    if (command === "/subagent") {
      await this.handleSubagentCommand(args);
      return;
    }

    if (command === "/memory") {
      this.showTextViewer("Memory", await runtime.runMemoryCommand(args));
      return;
    }

    if (command === "/review") {
      const instructions = args.join(" ").trim();
      const task = instructions
        || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
      this.showTextViewer("Code Review", await runtime.runSubagentTask(task) || "No review findings.");
      return;
    }

    if (command === "/compact") {
      this.showTextViewer("Compact", await runtime.compactConversation(args.join(" ").trim() || undefined));
      await this.refreshContextUsage();
      return;
    }

    if (command === "/model") {
      await this.handleModelCommand(args);
      return;
    }

    if (command === "/sessions" || (command === "/resume" && !args[0])) {
      await this.showSessionPicker();
      return;
    }

    if (command === "/resume") {
      await this.resumeSession(args[0] ?? "");
      return;
    }

    if (command === "/fork") {
      const upTo = args[1] === undefined ? undefined : Number.parseInt(args[1], 10);
      if (args[1] !== undefined && !Number.isSafeInteger(upTo)) {
        this.showTextViewer("Fork", "Usage: /fork [session] [upToEvent]");
        return;
      }
      const forked = await runtime.forkSession(args[0], upTo);
      this.showTextViewer("Fork", `Forked ${forked.sourceSessionId} at ${String(forked.events)} event(s) into ${forked.sessionId}\n${forked.filePath}`);
      return;
    }

    if (command === "/continue") {
      const interrupted = await runtime.interruptedTurn();
      // TUI 的运行走 durable-task 调度器，续跑目前只在 CLI 上接通；这里如实告知而不是
      // 悄悄开一个新回合 —— 那会让用户以为续上了，其实是重来。
      this.showTextViewer("Continue", interrupted
        ? `Interrupted after ${String(interrupted.completedSteps)} step(s): ${interrupted.prompt}\n\nRun \`biny chat\` and use /continue there to resume it; TUI resume is not wired yet.`
        : "No interrupted turn to continue.");
      return;
    }

    if (command === "/undo") {
      const checkpoints = await runtime.listCheckpoints();
      if (!checkpoints.length) {
        this.showTextViewer("Undo", "No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
        return;
      }
      if (args[0] === "list") {
        this.showTextViewer("Checkpoints", checkpoints.map((entry) => `${entry.id}  ${entry.createdAt}  ${entry.label}`).join("\n"));
        return;
      }
      const summary = await runtime.restoreCheckpoint(args[0] ?? "latest");
      const moved = summary.movedAside.length
        ? `\nMoved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}:\n${summary.movedAside.join("\n")}`
        : "";
      this.showTextViewer("Undo", `Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).${moved}`);
      return;
    }

    if (command === "/permissions" || command === "/approvals") {
      if (args.length === 0) {
        this.showPermissionModePicker();
        return;
      }
      this.showTextViewer("Permissions", await runtime.runPermissionCommand(args));
      this.permissionMode = runtime.getPermissionMode();
      this.refreshChrome();
      return;
    }

    if (command === "/plan") {
      const task = args.join(" ").trim();
      if (!task) {
        this.mode = this.mode === "plan" ? "chat" : "plan";
        this.refreshChrome();
        return;
      }
      this.mode = "plan";
      await runtime.sendPrompt(task, "plan");
      await this.refreshContextUsage();
      return;
    }

    // 未知命令是小错误，用一条通知就够，不必占一整个弹层。
    this.notify(`Unknown command: ${command}. Type / to see the list.`);
  }

  private async handleSubagentCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const action = args[0]?.toLowerCase();
    if (action === "status") {
      this.showTextViewer("Subagent tasks", formatSubagentTaskReport(runtime.listSubagentTasks()));
      return;
    }
    if (action === "agents") {
      this.showTextViewer("Named subagents", formatSubagentAgentList(await runtime.listSubagentAgents()));
      return;
    }
    if (action === "cancel") {
      const taskId = args[1]?.trim();
      if (!taskId) {
        this.showTextViewer("Subagent", "Usage: /subagent cancel <task-id>");
        return;
      }
      const cancelled = runtime.cancelSubagentTask(taskId, "Cancelled from the TUI.");
      this.showTextViewer(
        "Subagent",
        cancelled ? `Cancelled subagent task ${taskId}.` : `No active subagent task found for ${taskId}.`
      );
      return;
    }
    const task = args.join(" ").trim();
    if (!task) {
      this.showTextViewer("Subagent", "Usage: /subagent <read-only task> | status | cancel <task-id> | agents");
      return;
    }
    this.showTextViewer("Subagent", await runtime.runSubagentTask(task) || "Subagent returned no text.");
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    if (args[0]) {
      await this.applyModel(args[0], parseThinkingSelection(args[1]));
      return;
    }
    await runtime.refreshModelFromDisk();
    // 实时目录只是增强项；离线或未配置凭据时继续展示全局配置中的模型。
    await runtime.refreshModelCatalog().catch(() => undefined);
    const info = runtime.getInfo();
    const models = runtime.listModels();
    this.showSelect({
      title: "Select model",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, models.findIndex((model) => model.alias === info.modelAlias)),
      items: models.map((model) => ({
        value: model.alias,
        label: model.alias === info.modelAlias ? `${model.alias} ← current` : model.alias,
        description: `${model.provider}  ${model.description ?? model.model}`
      })),
      onSelect: (item) => {
        void this.selectModel(item.value);
      }
    });
  }

  private async selectModel(alias: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const model = runtime.listModels().find((candidate) => candidate.alias === alias);
    if (!model) {
      this.showTextViewer("Model", `Unknown model alias: ${alias}`);
      return;
    }
    if (!model.efforts.length) {
      await this.applyModel(alias, "off");
      return;
    }

    const current = runtime.getInfo();
    const currentThinking = current.modelAlias === alias && current.thinking !== "off"
      ? current.thinking
      : model.defaultThinking;
    const options = modelThinkingOptions(model);
    this.showSelect({
      title: `Select Reasoning Level for ${model.model}`,
      hint: "↑↓ navigate · enter select · esc back",
      selectedIndex: Math.max(0, options.findIndex((option) => option.value === currentThinking)),
      items: options.map((option) => ({
        value: option.value,
        label: option.value === currentThinking ? `${option.label} ← current` : option.label,
        description: option.description
      })),
      onSelect: (item) => {
        void this.applyModel(alias, item.value as ThinkingSelection);
      }
    });
  }

  private async applyModel(alias: string, thinking?: ThinkingSelection): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const info = await runtime.switchModel(alias, thinking);
      this.thinking = info.thinking;
      this.editor.borderColor = theme.thinkingBorder(this.thinking);
      this.notify(`Model changed to ${info.modelLabel} ${info.reasoningLabel.toLowerCase()}`);
    } catch (error) {
      this.showTextViewer("Model", `Model switch failed: ${describeError(error)}`);
    }
  }

  private showPermissionModePicker(): void {
    this.showSelect({
      title: "Select permission mode",
      hint: "↑↓ navigate · enter select · esc cancel",
      selectedIndex: Math.max(0, permissionModeOptions.findIndex((option) => option.mode === this.permissionMode)),
      items: permissionModeOptions.map((option) => ({
        value: option.mode,
        label: option.mode === this.permissionMode ? `${option.label} ← current` : option.label,
        description: option.description
      })),
      onSelect: (item) => {
        void this.applyPermissionMode(item.value as PermissionMode);
      }
    });
  }

  private async applyPermissionMode(mode: PermissionMode): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    await runtime.setPermissionMode(mode);
    this.permissionMode = mode;
    this.notify(formatPermissionModeChanged(mode));
  }

  private async showSessionPicker(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const summaries = (await runtime.listSessions())
      .filter((summary) => summary.firstUserMessage.trim())
      .slice()
      .reverse();
    if (!summaries.length) {
      this.showTextViewer("Sessions", "No sessions yet.");
      return;
    }
    this.showSelect({
      title: "Resume session",
      hint: "↑↓ navigate · enter resume · esc cancel",
      items: summaries.map((summary) => ({
        value: summary.fileName.replace(/\.jsonl$/, ""),
        label: sessionLabel(summary),
        description: summary.firstUserMessage.replace(/\s+/g, " ").slice(0, 80)
      })),
      onSelect: (item) => {
        void this.resumeSession(item.value);
      }
    });
  }

  private async resumeSession(session: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !session) return;
    const resumed = await runtime.resumeSession(session);
    this.chatContainer.reset();
    this.dispatch({
      type: "transcript.replaced",
      viewingSessionId: resumed.sessionId,
      items: sessionEventsToTranscript(resumed.events)
    });
    this.mode = "chat";
    await this.refreshContextUsage();
  }

  // ---------------------------------------------------------------- 退出

  async exit(): Promise<void> {
    // 幂等：Ctrl+C 和外部关闭可能同时触发。
    if (this.exiting) return;
    this.exiting = true;
    this.unsubscribe?.();
    this.status.dispose();
    if (this.runtime) {
      const info = this.runtime.getInfo();
      this.exitSummary = { sessionId: info.sessionId, sessionFile: info.sessionFile };
      await this.runtime.close();
    }
    this.ui.stop();
    this.resolveExit?.();
  }
}

function sessionLabel(summary: SessionSummary): string {
  return summary.fileName.replace(/\.jsonl$/, "");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
