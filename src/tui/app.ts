/**
 * TUI 应用外壳。
 *
 * 负责把终端渲染循环、TUI runtime、reducer 状态和各展示组件串起来：
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
import { formatSessionAge } from "./transcriptText.js";
import type { PermissionChoice, TuiPermissionRequest, TuiState, TuiStatus } from "./types.js";
import type { AgentAttachment, AgentRunMode } from "../agent/AgentSession.js";
import type { SkillDefinition } from "../extensions/skills.js";

export interface TuiExitSummary {
  sessionId: string;
  sessionFile: string;
}

const TUI_SLASH_COMMANDS = slashCommandsForSurface("tui");
const TUI_AUTOCOMPLETE_COMMANDS = TUI_SLASH_COMMANDS.filter((command) => command.name !== "/skills");

/** 把已加载 Skill 的元数据投影成 Pi 风格的 `skill:<name>` 补全项。 */
export function skillSlashCommandItems(
  skills: readonly Pick<SkillDefinition, "name" | "description">[]
): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ name: `skill:${skill.name}`, description: skill.description }));
}

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
  /** 与 pi 一致：空闲时 Ctrl+C 需要在短时间内连续按两次才退出。 */
  private lastCtrlCAt = 0;
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
    this.ui.addInputListener((data) => {
      if (shouldConfirmAutocompleteOnEnter(data, this.editor.isShowingAutocomplete(), this.editor.getText())) {
        // pi-tui 的 Editor 对 slash 补全会在 Enter 确认后继续 fall through 到 submit。
        // 在 TUI 边界把这次 Enter 转成 Tab，只完成插入，下一次 Enter 才是用户发送。
        this.editor.handleInput("\t");
        // 全局监听器消费了原始 Enter，TUI 不会再自动请求重绘；补全后的文本要立即可见。
        this.ui.requestRender();
        return { consume: true };
      }
      if (this.editor.isShowingAutocomplete() && matchesKey(data, "escape")) {
        // 忙碌时 Escape 默认会取消 Agent；补全弹层打开时应先关闭弹层，不能误取消当前任务。
        this.dismissAutocomplete();
        return { consume: true };
      }
      return this.handleGlobalKey(data);
    });
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
      this.setAutocompleteProvider(commands.listSkills(), info.workspaceRoot);
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
        else if (update.snapshot.state.kind === "maintenance") this.dispatch({ type: "maintenance.started" });
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

  private setAutocompleteProvider(skills: readonly SkillDefinition[], workspaceRoot: string): void {
    const provider = new CombinedAutocompleteProvider(
      [
        ...TUI_AUTOCOMPLETE_COMMANDS.map((command) => ({
          name: command.name.replace(/^\//, ""),
          description: command.description
        })),
        ...skillSlashCommandItems(skills)
      ],
      workspaceRoot
    );
    this.editor.setAutocompleteProvider(provider);
  }

  private dispatch(event: Parameters<typeof tuiReducer>[1]): void {
    const nextState = tuiReducer(this.state, event);
    // 长思考会产生大量 reasoning.delta；这些增量只用于 provider/session，TUI
    // 不展示原文。忽略没有改变界面的增量，避免每个 token 都同步组件树并请求重绘。
    if (nextState === this.state && event.type === "reasoning.delta") return;
    this.state = nextState;
    this.syncPermissionDialog();
    this.chatContainer.sync(this.state.transcript);
    this.refreshChrome();
  }

  private notify(content: string): void {
    this.dispatch({ type: "system.message", content });
  }

  private refreshChrome(): void {
    const status = runtimeStatus(this.runtimeSnapshot);
    this.status.setState(status, this.state.turnStartedAt, this.state.lastWorkedMs);
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
    const runtime = this.runtime;
    const commands = this.commands;
    // TUI 在 runtime 启动完成前已经可以接收键盘输入；不能因为 Editor 已清空而丢掉这条消息。
    if (!runtime) {
      this.setEditorText(text);
      this.ui.requestRender();
      return;
    }
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    this.setPendingAttachments([]);
    this.setEditorText("");
    this.editor.addToHistory(prompt);
    void appendInputHistory(this.workspaceRoot, prompt)
      .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));

    if (value.startsWith("/skill:") && runtime && commands) {
      try {
        // 与 Pi 一致：补全只显示元数据，按 Enter 后才读取并注入 Skill 正文。
        const expandedPrompt = await commands.expandSkillCommand(value);
        const input = withAttachmentReferences(expandedPrompt, attachments);
        if (runtimeIsBusy(this.runtimeSnapshot)) {
          runtime.followUp(input, attachments);
          this.notify("Skill 消息已加入 follow-up 队列，将在当前任务准备结束时继续处理。");
          return;
        }
        await runtime.submitPrompt(input, this.mode, attachments).completion;
      } catch (error) {
        this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
        this.setEditorText(prompt);
        this.dispatch({ type: "error.message", message: describeError(error) });
      } finally {
        await this.refreshContextUsage();
      }
      return;
    }

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

    try {
      if (runtimeIsBusy(this.runtimeSnapshot)) {
        runtime.followUp(withAttachmentReferences(prompt, attachments), attachments);
        this.notify("消息已加入 follow-up 队列，将在当前任务准备结束时继续处理。");
        return;
      }
      await runtime.submitPrompt(withAttachmentReferences(prompt, attachments), this.mode, attachments).completion;
    } catch (error) {
      this.setPendingAttachments([...attachments, ...this.pendingAttachments]);
      this.setEditorText(prompt);
      this.dispatch({ type: "error.message", message: describeError(error) });
    } finally {
      await this.refreshContextUsage();
    }
  }

  /** 全局键位。返回 `{consume:true}` 表示不再投递给焦点组件。 */
  private handleGlobalKey(data: string): { consume?: boolean } | undefined {
    const busy = runtimeIsBusy(this.runtimeSnapshot);

    if (matchesKey(data, "ctrl+s") && busy && !this.overlay) {
      this.dismissAutocomplete();
      void this.steerCurrentInput();
      return { consume: true };
    }

    // 选择器自己处理 Ctrl+C 作为取消，不让全局退出逻辑抢先执行。
    if (matchesKey(data, "ctrl+c") && this.overlay) {
      this.lastCtrlCAt = 0;
      return undefined;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        this.lastCtrlCAt = 0;
        this.dismissAutocomplete();
        this.runtime?.cancelCurrentRun();
        return { consume: true };
      }
      const now = Date.now();
      if (isDoubleCtrlC(this.lastCtrlCAt, now)) {
        this.lastCtrlCAt = 0;
        void this.exit();
      } else {
        this.lastCtrlCAt = now;
        this.setEditorText("");
        this.setPendingAttachments([]);
      }
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
    // Windows 终端通常把 Ctrl+V 留给文本粘贴，只用 Alt+V 读取图片剪贴板。
    const isClipboardPaste = process.platform === "win32" ? matchesKey(data, "alt+v") : matchesKey(data, "ctrl+v");
    if (isClipboardPaste) {
      this.dismissAutocomplete();
      void this.pasteClipboard();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") && !this.editor.isShowingAutocomplete()) {
      this.mode = this.mode === "plan" ? "chat" : "plan";
      this.refreshChrome();
      return { consume: true };
    }
    return undefined;
  }

  private async steerCurrentInput(): Promise<void> {
    const runtime = this.runtime;
    const commands = this.commands;
    if (!runtime || !commands) return;
    const value = this.editor.getText().trim();
    if (!value && !this.pendingAttachments.length) return;
    const prompt = value || "请分析这个附件。";
    const attachments = this.pendingAttachments;
    try {
      const expandedPrompt = value.startsWith("/skill:")
        ? await commands.expandSkillCommand(value)
        : prompt;
      runtime.steer(withAttachmentReferences(expandedPrompt, attachments), attachments);
      this.setPendingAttachments([]);
      this.setEditorText("");
      this.editor.addToHistory(prompt);
      void appendInputHistory(this.workspaceRoot, prompt)
        .catch((error) => this.notify(`写入输入历史失败：${describeError(error)}`));
      this.notify("消息已加入 steer 队列，将在当前模型步骤和工具批次结束后处理。");
    } catch (error) {
      this.dispatch({ type: "error.message", message: describeError(error) });
    }
  }

  private async pasteClipboard(): Promise<void> {
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

  private setPendingAttachments(attachments: AgentAttachment[]): void {
    this.pendingAttachments = attachments;
    this.pendingAttachmentsView.setAttachments(attachments);
    this.ui.requestRender();
  }

  private setEditorText(text: string): void {
    this.editor.setText(text);
  }

  private dismissAutocomplete(): void {
    if (!this.editor.isShowingAutocomplete()) return;
    this.editor.handleInput("\x1b");
    this.ui.requestRender();
  }

  // ---------------------------------------------------------------- 弹层

  private showOverlay(component: Container, options?: {
    maxHeight?: `${number}%`;
    placement?: "below_editor";
  }): void {
    this.dismissAutocomplete();
    this.closeOverlay();
    const maxHeight = options?.maxHeight ?? "70%";
    const row = options?.placement === "below_editor"
      ? selectDialogRow(
        this.ui.render(this.ui.terminal.columns).length,
        Math.min(
          component.render(this.ui.terminal.columns).length,
          Math.max(1, Math.floor(this.ui.terminal.rows * Number.parseFloat(maxHeight) / 100))
        ),
        this.ui.terminal.rows,
        this.footer.render(this.ui.terminal.columns).length + this.shortcuts.render(this.ui.terminal.columns).length
      )
      : undefined;
    this.overlay = this.ui.showOverlay(component, {
      width: "100%",
      anchor: row === undefined ? "bottom-center" : undefined,
      row,
      maxHeight
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
    this.showOverlay(dialog, { placement: "below_editor" });
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
        hint: "↑↓ navigate · enter insert · esc/ctrl+c cancel",
        onSelect: (item) => {
          this.setEditorText(`${item.value} `);
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

    const sharedResult = await executeRuntimeCommand(runtime, commands, value, "tui");
    if (sharedResult) {
      this.showTextViewer(sharedResult.title, sharedResult.content);
      if (command === "/compact") await this.refreshContextUsage();
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
    // /model 只读取配置和已恢复的目录缓存，不能因为远程目录请求阻塞模型选择。
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
      .slice();
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

/** Skill 补全沿用两步交互，普通 slash 命令则由 Editor 在同一次 Enter 中提交。 */
export function shouldConfirmAutocompleteOnEnter(
  data: string,
  autocompleteVisible: boolean,
  inputText: string
): boolean {
  return autocompleteVisible && /^\/skill(?::|$)/u.test(inputText.trimStart()) && matchesKey(data, "enter");
}

/** 判断两次 Ctrl+C 是否处于 pi 的 500ms 退出窗口内。 */
export function isDoubleCtrlC(lastCtrlCAt: number, now: number): boolean {
  return lastCtrlCAt > 0 && now >= lastCtrlCAt && now - lastCtrlCAt < 500;
}

function sessionLabel(summary: SessionSummary, nowMs: number): string {
  return `${summary.fileName.replace(/\.jsonl$/, "")} · ${formatSessionAge(summary.updatedAt, nowMs)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runtimeStatus(snapshot: InteractiveRuntimeSnapshot | undefined): TuiStatus {
  if (!snapshot || snapshot.state.kind === "idle") return "idle";
  // 模型切换、会话恢复和内存整理等 maintenance 不是 Agent 工作回合，
  // 状态行保持空闲留白，不展示 Working 或耗时。
  if (snapshot.state.kind !== "runs") return "idle";
  if (snapshot.state.pendingPermission) return "waiting_permission";
  return snapshot.state.activeRun.status === "thinking" ? "thinking" : "running";
}

/**
 * 选择器从输入框下方展开，临时覆盖 footer 和快捷键行。
 * 窄终端或长列表时向上收缩，保证弹层不越过当前视口。
 */
export function selectDialogRow(
  contentHeight: number,
  dialogHeight: number,
  terminalHeight: number,
  chromeTailHeight: number
): number {
  const belowEditor = Math.max(0, contentHeight - chromeTailHeight);
  return Math.min(belowEditor, Math.max(0, terminalHeight - dialogHeight));
}

function tuiPermissionRequest(snapshot: InteractiveRuntimeSnapshot | undefined): TuiPermissionRequest | undefined {
  const pending = pendingPermission(snapshot);
  if (!pending) return undefined;
  return { ...pending.request };
}
