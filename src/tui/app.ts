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
import { slashCommandsForSurface } from "../runtime/commandRegistry.js";
import { withAttachmentReferences } from "../attachments/references.js";
import { forkSession } from "../session/fork.js";
import { executeRuntimeCommand } from "../runtime/commands.js";
import {
  createInteractiveAgentHost,
  type InteractiveAgentRuntime
} from "../runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../runtime/CommandRuntime.js";
import {
  isTerminalRunEvent,
  pendingPermission,
  runtimeIsBusy,
  type InteractiveRuntimeSnapshot
} from "../runtime/agentEvents.js";
import type { SessionSummary } from "../session/events.js";
import { FooterComponent, ShortcutsBarComponent, StatusIndicatorComponent, WelcomeComponent } from "./components/chrome.js";
import { PermissionDialog, SelectDialog, TextViewerDialog } from "./components/dialogs.js";
import { ThinkingComponent, ToolExecutionComponent } from "./components/messages.js";
import { PendingAttachmentsComponent } from "./components/pendingAttachments.js";
import { TranscriptView } from "./components/transcriptView.js";
import { appendInputHistory, loadInputHistory } from "./inputHistory.js";
import { permissionModeOptions } from "./permissionModeOptions.js";
import { pasteTuiClipboard } from "./runtime/clipboard.js";
import { permissionChoiceToResult } from "./runtime/permissionChoice.js";
import { readGitBranch } from "./runtime/gitBranch.js";
import { sessionEventsToTranscript } from "./sessionTranscript.js";
import { modelThinkingOptions } from "./modelOptions.js";
import { createInitialTuiState, tuiReducer } from "./reducer.js";
import { editorTheme, theme } from "./theme/index.js";
import { foldableTranscriptItems, formatSessionAge, latestExpandableTranscript } from "./transcriptText.js";
import type { PermissionChoice, TuiPermissionRequest, TuiState, TuiStatus } from "./types.js";
import type { AgentAttachment, AgentRunMode } from "../agent/AgentSession.js";

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

const TUI_SLASH_COMMANDS = slashCommandsForSurface("tui");

export class BinyTui {
  private readonly ui: TUI;
  private readonly workspaceRoot: string;
  private readonly version: string | undefined;
  private readonly initialSession: string | undefined;

  private state: TuiState;
  private runtime: InteractiveAgentRuntime | undefined;
  private commands: CommandRuntime | undefined;
  private runtimeSnapshot: InteractiveRuntimeSnapshot | undefined;

  private readonly headerContainer = new Container();
  private readonly chatContainer = new TranscriptView();
  private readonly editorContainer = new Container();
  private readonly pendingAttachmentsView = new PendingAttachmentsComponent();
  private readonly status: StatusIndicatorComponent;
  private readonly footer: FooterComponent;
  private readonly shortcuts = new ShortcutsBarComponent();
  private readonly editor: Editor;

  private mode: Extract<AgentRunMode, "chat" | "plan"> = "chat";
  /** 当前输入尚未发送的图片；实际读写剪贴板和存储都在 TUI runtime。 */
  private pendingAttachments: AgentAttachment[] = [];
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

  constructor(ui: TUI, workspaceRoot: string, version?: string, initialSession?: string) {
    this.ui = ui;
    this.workspaceRoot = workspaceRoot;
    this.version = version;
    this.initialSession = initialSession;
    this.state = createInitialTuiState(workspaceRoot);
    this.status = new StatusIndicatorComponent(ui);
    this.footer = new FooterComponent(this.footerData());
    this.editor = new Editor(ui, editorTheme(), { paddingX: 1 });
    this.editorContainer.addChild(this.pendingAttachmentsView);
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
      const { runtime, commands } = await createInteractiveAgentHost(this.workspaceRoot);
      this.runtime = runtime;
      this.commands = commands;
      this.runtimeSnapshot = runtime.getSnapshot();
      const { info, permissionMode } = this.runtimeSnapshot;
      this.permissionMode = permissionMode;
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

      this.unsubscribe = runtime.subscribe((update) => {
        this.runtimeSnapshot = update.snapshot;
        if (update.event) this.dispatch(update.event);
        else this.refreshChrome();
        if (isTerminalRunEvent(update.event)) {
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
      if (this.initialSession) await this.resumeSession(this.initialSession);
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
    const status = runtimeStatus(this.runtimeSnapshot);
    this.status.setState(status);
    this.shortcuts.setState(status, this.mode);
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
    if (!this.commands) return;
    try {
      const context = await this.commands.agent.contextStatus();
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
    if (!value && !this.pendingAttachments.length) return;
    if (!value.startsWith("/") && runtimeIsBusy(this.runtimeSnapshot)) {
      this.notify("当前任务仍在运行。按 Esc 停止后再发送下一条消息。");
      return;
    }
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    this.setPendingAttachments([]);
    this.editor.setText("");
    this.editor.addToHistory(prompt);
    void appendInputHistory(this.workspaceRoot, prompt)
      .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));

    if (value.startsWith("/")) {
      // slash 命令不消费附件；保留它们给用户执行命令后继续编辑并发送。
      this.setPendingAttachments(attachments);
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
      await runtime.submitPrompt(withAttachmentReferences(prompt, attachments), this.mode, attachments).completion;
    } catch (error) {
      this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
      this.editor.setText(prompt);
      this.dispatch({ type: "error.message", message: describeError(error) });
    } finally {
      await this.refreshContextUsage();
    }
  }

  /** 全局键位。返回 `{consume:true}` 表示不再投递给焦点组件。 */
  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    const busy = runtimeIsBusy(this.runtimeSnapshot);

    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        this.runtime?.cancelCurrentRun();
        return { consume: true };
      }
      void this.exit();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.overlay) return undefined;
      if (busy) {
        this.runtime?.cancelCurrentRun();
        return { consume: true };
      }
      return undefined;
    }
    if (this.overlay) return undefined;
    // Windows 终端通常把 Ctrl+V 留给文本粘贴，和 Pi 一样只用 Alt+V 读取图片剪贴板。
    const isClipboardPaste = process.platform === "win32" ? matchesKey(data, "alt+v") : matchesKey(data, "ctrl+v");
    if (isClipboardPaste) {
      void this.pasteClipboard();
      return { consume: true };
    }
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

  private async pasteClipboard(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const pasted = await pasteTuiClipboard(this.workspaceRoot);
      if (pasted.kind === "image") {
        this.setPendingAttachments([...this.pendingAttachments, pasted.attachment]);
        this.notify(`已附加 [Image #${String(this.pendingAttachments.length)}]。按 Enter 发送；当前模型需声明 vision 能力。`);
        return;
      }
      if (pasted.kind === "text") {
        this.editor.insertTextAtCursor(pasted.text);
        this.ui.requestRender();
        return;
      }
      this.notify("剪贴板中没有可读取的图片或文本。");
    } catch (error) {
      this.notify(`读取剪贴板失败：${describeError(error)}`);
    }
  }

  private showLatestDetails(): void {
    const expandable = latestExpandableTranscript(this.state.transcript);
    if (expandable) this.showTextViewer(expandable.title, expandable.content);
  }

  private setPendingAttachments(attachments: AgentAttachment[]): void {
    this.pendingAttachments = attachments;
    this.pendingAttachmentsView.setAttachments(attachments);
    this.ui.requestRender();
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
    const request = tuiPermissionRequest(this.runtimeSnapshot);
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
        this.answerPermission(choice);
      },
      () => {
        this.dispatch({ type: "permission.details.toggled" });
      },
      Math.max(10, this.ui.terminal.rows - 4)
    );
    dialog.setDetailsExpanded(this.state.permissionDetailsExpanded);
    this.permissionDialog = dialog;
    this.showOverlay(dialog, { maxHeight: "100%" });
  }

  private answerPermission(choice: PermissionChoice): void {
    const runtime = this.runtime;
    const request = pendingPermission(this.runtimeSnapshot);
    if (!runtime || !request) return;
    runtime.answerPermission(
      request.requestId,
      permissionChoiceToResult(choice, request.request.requireFullYes)
    );
  }

  // ---------------------------------------------------------------- slash

  private async handleSlashCommand(value: string): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime || !commands) return;
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
      const forked = await forkSession(
        commands.persistenceRoot,
        args[0],
        upTo === undefined ? {} : { upToEvent: upTo }
      );
      this.showTextViewer("Fork", `Forked ${forked.sourceSessionId} at ${String(forked.events)} event(s) into ${forked.sessionId}\n${forked.filePath}`);
      return;
    }

    if (command === "/permissions" || command === "/approvals") {
      if (args.length === 0) {
        this.showPermissionModePicker();
        return;
      }
      this.showTextViewer(
        "Permissions",
        await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.runPermissionCommand(args)
        )
      );
      this.permissionMode = runtime.getSnapshot().permissionMode;
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
      if (runtimeIsBusy(this.runtimeSnapshot)) {
        this.notify("当前任务仍在运行。按 Esc 停止后再提交 Plan。");
        return;
      }
      this.mode = "plan";
      await runtime.submitPrompt(task, "plan").completion;
      await this.refreshContextUsage();
      return;
    }

    if (command === "/mode") {
      const requested = args[0]?.toLowerCase();
      if (!requested) {
        this.showSelect({
          title: "Select run mode",
          hint: "↑↓ navigate · enter select · esc cancel",
          selectedIndex: runModes.findIndex((entry) => entry.mode === this.mode),
          items: runModes.map((entry) => ({ value: entry.mode, label: entry.label, description: entry.description })),
          onSelect: (item) => {
            this.mode = item.value as Extract<AgentRunMode, "chat" | "plan">;
            this.refreshChrome();
          }
        });
        return;
      }
      if (requested !== "chat" && requested !== "plan") {
        this.showTextViewer("Mode", "Usage: /mode [chat|plan]");
        return;
      }
      this.mode = requested;
      this.refreshChrome();
      return;
    }

    const sharedResult = await executeRuntimeCommand(runtime, commands, value, "tui");
    if (sharedResult) {
      this.showTextViewer(sharedResult.title, sharedResult.content);
      if (command === "/compact" || command === "/continue") await this.refreshContextUsage();
      return;
    }

    // 未知命令是小错误，用一条通知就够，不必占一整个弹层。
    this.notify(`Unknown command: ${command}. Type / to see the list.`);
  }

  private async handleModelCommand(args: string[]): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime || !commands) return;
    if (args[0]) {
      await this.applyModel(args[0], parseThinkingSelection(args[1]));
      return;
    }
    await runtime.runExclusiveOperation(
      "refresh_model",
      async () => await commands.agent.refreshModelFromDisk()
    );
    // 实时目录只是增强项；离线或未配置凭据时继续展示全局配置中的模型。
    await runtime.runExclusiveOperation(
      "model_catalog",
      async () => await commands.agent.refreshModelCatalog()
    ).catch(() => undefined);
    const info = runtime.getSnapshot().info;
    const models = commands.agent.listModels();
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
    const commands = this.commands;
    if (!runtime || !commands) return;
    const model = commands.agent.listModels().find((candidate) => candidate.alias === alias);
    if (!model) {
      this.showTextViewer("Model", `Unknown model alias: ${alias}`);
      return;
    }
    if (!model.efforts.length) {
      await this.applyModel(alias, "off");
      return;
    }

    const current = runtime.getSnapshot().info;
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
    const commands = this.commands;
    if (!runtime || !commands) return;
    try {
      const info = await runtime.runExclusiveOperation(
        "switch_model",
        async () => await commands.agent.switchModel(alias, thinking)
      );
      this.dispatch({
        type: "model.changed",
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel
      });
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
    const commands = this.commands;
    if (!runtime || !commands) return;
    await runtime.runExclusiveOperation(
      "permission",
      async () => await commands.agent.setPermissionMode(mode)
    );
    this.permissionMode = mode;
    this.notify(formatPermissionModeChanged(mode));
  }

  private async showSessionPicker(): Promise<void> {
    const commands = this.commands;
    if (!commands) return;
    const summaries = (await commands.agent.listSessions())
      .filter((summary) => summary.firstUserMessage.trim())
      .slice()
      .reverse();
    if (!summaries.length) {
      this.showTextViewer("Sessions", "No sessions yet.");
      return;
    }
    const nowMs = Date.now();
    this.showSelect({
      title: "Resume session",
      hint: "↑↓ navigate · enter resume · esc cancel",
      items: summaries.map((summary) => ({
        value: summary.fileName.replace(/\.jsonl$/, ""),
        label: sessionLabel(summary, nowMs),
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
    const info = runtime.getSnapshot().info;
    this.dispatch({
      type: "session.started",
      sessionId: info.sessionId,
      sessionFile: info.sessionFile,
      cwd: info.workspaceRoot,
      provider: info.provider,
      modelLabel: info.modelLabel,
      reasoningLabel: info.reasoningLabel
    });
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
      const info = this.runtime.getSnapshot().info;
      this.exitSummary = { sessionId: info.sessionId, sessionFile: info.sessionFile };
      await this.runtime.close();
    }
    this.ui.stop();
    this.resolveExit?.();
  }
}

function sessionLabel(summary: SessionSummary, nowMs: number): string {
  return `${summary.fileName.replace(/\.jsonl$/, "")} · ${formatSessionAge(summary.updatedAt, nowMs)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const runModes: Array<{ mode: Extract<AgentRunMode, "chat" | "plan">; label: string; description: string }> = [
  { mode: "chat", label: "Chat", description: "直接执行一个 Agent 回合" },
  { mode: "plan", label: "Plan", description: "只读分析与方案，不执行副作用工具" }
];

function runtimeStatus(snapshot: InteractiveRuntimeSnapshot | undefined): TuiStatus {
  if (!snapshot || snapshot.state.kind === "idle") return "idle";
  if (snapshot.state.kind !== "runs") return "running";
  if (snapshot.state.pendingPermission) return "waiting_permission";
  return snapshot.state.activeRun.status === "thinking" ? "thinking" : "running";
}

function tuiPermissionRequest(snapshot: InteractiveRuntimeSnapshot | undefined): TuiPermissionRequest | undefined {
  const pending = pendingPermission(snapshot);
  if (!pending) return undefined;
  return { ...pending.request };
}
