/**
 * 底部输入区：文本输入、附件、模式（chat/plan）、模型、思考级别、权限模式切换、上下文用量与
 * slash 命令菜单。
 *
 * 只负责收集用户意图并回调，不直接调用 IPC，也不判断能不能发送——`running`、`activeElsewhere`、
 * `modelSetupRequired` 等状态由上层传入。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentSessionInfo, InteractiveAgentRunMode } from "../../../../agent/AgentSession.js";
import type { ModelChoice, ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopAttachment, DesktopProject, DesktopSlashCommand } from "../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../protocol.js";
import { catalogForConnection } from "../providerCatalog.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";

interface ComposerProps {
  project?: DesktopProject;
  sessionId?: string;
  runtimeInfo?: AgentSessionInfo;
  permissionMode: PermissionMode;
  models: ModelChoice[];
  /** 已解析好的上下文用量；取不到真实数字时为空，此时不展示用量。 */
  contextUsage?: ContextUsage;
  running: boolean;
  activeElsewhere: boolean;
  modelSetupRequired: boolean;
  focusToken: number;
  onOpenProject(): void;
  onSend(input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[]): Promise<void>;
  onSlashCommand(command: string): Promise<void>;
  onStop(): Promise<void>;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

type ComposerMenu = "permission" | "model" | "thinking" | null;

const permissionOptions: Array<{ mode: PermissionMode; label: string; description: string; risk?: string }> = [
  { mode: "ask", label: "每次询问", description: "写入、执行和其他敏感操作会请求确认" },
  { mode: "auto", label: "自动允许安全修改", description: "自动允许低风险操作，其他操作仍会询问" },
  { mode: "read-only", label: "只读", description: "允许读取，拒绝修改和命令执行" },
  { mode: "full-access", label: "完全访问", description: "除项目规定的关键操作外自动允许", risk: "高风险" }
];

export const Composer = memo(function Composer({
  project,
  sessionId,
  runtimeInfo,
  permissionMode,
  models,
  contextUsage,
  running,
  activeElsewhere,
  modelSetupRequired,
  focusToken,
  onOpenProject,
  onSend,
  onSlashCommand,
  onStop,
  onPermissionMode,
  onSwitchModel,
  onSaveAttachment
}: ComposerProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InteractiveAgentRunMode>("chat");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (focusToken) textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (!menu) return;
    // Only the open popover and its trigger count as "inside". Clicks on the
    // chat textarea or other composer chrome should dismiss the menu.
    const isInsideOpenMenu = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".composer-popover")) return true;
      return Boolean(target.closest(`[data-composer-menu="${menu}"]`));
    };
    const close = (event: PointerEvent): void => {
      if (isInsideOpenMenu(event.target)) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    const focus = (event: FocusEvent): void => {
      if (isInsideOpenMenu(event.target)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("focusin", focus);
    };
  }, [menu]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${String(Math.min(176, Math.max(46, textarea.scrollHeight)))}px`;
  }, [input]);

  // 仅当整个输入还是一个未完成的 "/xxx" 词（无空白、无换行）时弹出命令菜单；
  // "/ 开头的普通句子" 不应被劫持成命令。
  const slashQuery = input.startsWith("/") && input.length > 0 && !/\s/.test(input) ? input : "";
  const slashMatches = slashQuery && !slashDismissed
    ? DESKTOP_SLASH_COMMANDS.filter((command) => command.name.startsWith(slashQuery))
    : [];
  const slashMenuOpen = slashMatches.length > 0 && !busy;

  const runSlash = async (command: string): Promise<void> => {
    if (!project || busy) return;
    setInput("");
    setError(undefined);
    setBusy(true);
    try {
      await onSlashCommand(command);
    } catch (slashError) {
      setInput(command);
      setError(errorMessage(slashError));
    } finally {
      setBusy(false);
    }
  };

  // 需要参数的命令（如 /subagent <task>）从菜单选中时只补全名称，让用户接着写参数。
  const chooseSlashCommand = (command: DesktopSlashCommand): void => {
    if (command.requiresArgs) {
      setInput(`${command.name} `);
      textareaRef.current?.focus();
      return;
    }
    void runSlash(command.name);
  };

  const submit = async (): Promise<void> => {
    const value = input.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!project || !value || busy) return;
    // 命令是否接收参数由共享注册表声明；其他以 / 开头的自然语言仍作为普通消息发送。
    const [slashName] = value.split(/\s+/, 1);
    const slashCommand = DESKTOP_SLASH_COMMANDS.find((command) => command.name === slashName);
    if (slashCommand && (value === slashCommand.name || slashCommand.acceptsArgs)) {
      await runSlash(value);
      return;
    }
    if (activeElsewhere) return;
    setInput("");
    const sentAttachments = attachments;
    setAttachments([]);
    setError(undefined);
    setBusy(true);
    try {
      await onSend(value, mode, sentAttachments);
    } catch (submitError) {
      setInput(value);
      setAttachments(sentAttachments);
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (files: File[]): Promise<void> => {
    if (!project || !files.length) return;
    setError(undefined);
    setBusy(true);
    try {
      const saved = await Promise.all(files.slice(0, 20).map(onSaveAttachment));
      setAttachments((current) => [...current, ...saved].slice(0, 20));
    } catch (attachmentError) {
      setError(errorMessage(attachmentError));
    } finally {
      setBusy(false);
    }
  };

  const placeholder = !project
    ? "请先打开一个项目"
    : modelSetupRequired
      ? "请先配置模型"
    : activeElsewhere
      ? "另一个会话正在运行；切回后可继续补充"
      : running
        ? "可以继续补充要求"
        : "描述你想完成的任务";
  // 运行时是懒创建的：没有 runtimeInfo 时退回配置里的首选模型（列表已按 defaultModel 排在最前）。
  // 两种情况都用 ModelChoice 的 displayName 作为按钮文案，避免同一个模型在「有运行时 / 没运行时」
  // 之间显示成两种名字，看起来像模型被切换了。
  const activeModel = models.find((model) => model.alias === runtimeInfo?.modelAlias);
  const selectedModel = activeModel ?? models[0];
  const currentAlias = activeModel?.alias ?? selectedModel?.alias;
  const currentThinking = runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";
  const modelName = activeModel?.displayName ?? runtimeInfo?.modelLabel ?? selectedModel?.displayName ?? "选择模型";
  const thinkingEfforts = selectedModel?.efforts ?? [];
  const usage = formatContextUsage(contextUsage);

  return (
    <div
      className={`composer-container${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
      ref={composerRef}
    >
      {project ? (
        <div className="composer-context">
          <button className="context-segment" onClick={onOpenProject} type="button"><Icon name="folder" size={15} /><span>{project.name}</span><Icon name="chevron" size={11} /></button>
          {project.branch ? <span className="context-segment is-static"><Icon name="branch" size={14} /><span>{project.branch}</span></span> : null}
        </div>
      ) : null}
      <div className="composer-shell">
        {attachments.length ? (
          <div className="attachment-list">
            {attachments.map((attachment, index) => (
              <div className="attachment-chip" key={`${attachment.path}-${String(index)}`}>
                <Icon name={attachment.mimeType.startsWith("image/") ? "spark" : "file"} size={13} />
                <span>{attachment.name}</span>
                <button aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button"><Icon name="close" size={11} /></button>
              </div>
            ))}
          </div>
        ) : null}

        {slashMenuOpen ? (
          <div className="composer-popover slash-menu" role="menu">
            <div className="popover-heading">命令</div>
            {slashMatches.map((command, index) => (
              <button
                className={`menu-option${index === slashIndex ? " is-selected" : ""}`}
                key={command.name}
                onClick={() => chooseSlashCommand(command)}
                onMouseEnter={() => setSlashIndex(index)}
                role="menuitem"
                type="button"
              >
                <span className="menu-option-copy"><strong>{command.name}</strong><small>{command.description}</small></span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="任务输入"
          disabled={!project || activeElsewhere || modelSetupRequired}
          onChange={(event) => {
            setInput(event.target.value);
            setSlashIndex(0);
            setSlashDismissed(false);
          }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onCompositionStart={() => { composingRef.current = true; }}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            if (slashMenuOpen) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setSlashIndex((current) => (current + step + slashMatches.length) % slashMatches.length);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSlashDismissed(true);
                return;
              }
              // 带修饰键的 Enter（如 Shift+Enter 换行）不触发命令执行。
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)) {
                event.preventDefault();
                const selected = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
                if (selected) chooseSlashCommand(selected);
                return;
              }
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }}
          onPaste={(event) => {
            const images = [...event.clipboardData.items]
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (images.length) {
              event.preventDefault();
              void addFiles(images);
            }
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={input}
        />

        <div className="composer-actions">
          <div className="composer-actions-left">
            <input
              hidden
              multiple
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <button aria-label="添加附件" className="composer-icon-button" disabled={!project || busy || modelSetupRequired} onClick={() => fileInputRef.current?.click()} type="button"><Icon name="paperclip" /></button>
            <div className="composer-menu-anchor">
              <button className="composer-select" data-composer-menu="permission" disabled={!project || modelSetupRequired} onClick={() => setMenu(menu === "permission" ? null : "permission")} type="button">
                <span>{permissionLabel(permissionMode)}</span><Icon name="chevron" size={12} />
              </button>
              <PermissionMenu
                mode={permissionMode}
                open={menu === "permission"}
                onChange={(nextMode) => {
                  setMenu(null);
                  void onPermissionMode(nextMode).catch((permissionError) => setError(errorMessage(permissionError)));
                }}
              />
            </div>
            <button
              className={`mode-toggle${mode === "plan" ? " is-active" : ""}`}
              disabled={modelSetupRequired}
              onClick={() => setMode(mode === "plan" ? "chat" : "plan")}
              title="聊天直接执行；规划只读"
              type="button"
            >{runModeLabel(mode)}</button>
            {thinkingEfforts.length ? (
              <div className="composer-menu-anchor">
                <button className="composer-select thinking-trigger" data-composer-menu="thinking" disabled={!project || modelSetupRequired} onClick={() => setMenu(menu === "thinking" ? null : "thinking")} title="思考级别" type="button">
                  <Icon name="brain" size={13} /><span>{thinkingLabel(currentThinking)}</span>
                </button>
                <ThinkingMenu
                  current={currentThinking}
                  efforts={thinkingEfforts}
                  open={menu === "thinking"}
                  onChange={(thinking) => {
                    setMenu(null);
                    if (currentAlias) void onSwitchModel(currentAlias, thinking).catch((modelError) => setError(errorMessage(modelError)));
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="composer-actions-right">
            <div className="composer-menu-anchor">
              <button className="model-trigger" data-composer-menu="model" disabled={!project || !models.length || modelSetupRequired} onClick={() => setMenu(menu === "model" ? null : "model")} type="button">
                {selectedModel ? <span className="model-trigger-brand"><ProviderBrandGlyph type={selectedModel.providerType} /></span> : null}
                <span>{modelName}</span>
                <Icon name="chevron" size={12} />
              </button>
              <ModelMenu
                currentAlias={currentAlias}
                models={models}
                open={menu === "model"}
                onChange={(alias, thinking) => {
                  void onSwitchModel(alias, thinking).catch((modelError) => setError(errorMessage(modelError)));
                }}
              />
            </div>
            {usage ? (
              <span className="context-usage" role="status">
                <Icon name="timer" size={12} /><span>{usage.percent}%</span>
                <span className="context-usage-tip">上下文使用量<strong>{usage.used} / {usage.max} tokens</strong></span>
              </span>
            ) : null}
            <button
              aria-label={running ? "暂停生成" : "发送任务"}
              className="send-button"
              disabled={running ? false : (!input.trim() && !attachments.length) || !project || busy || activeElsewhere}
              onClick={() => { if (running) void onStop(); else void submit(); }}
              title={running ? "暂停当前生成" : sessionId ? "发送" : "创建任务并发送"}
              type="button"
            >
              {/* 两个图标的字号不同是有意的：箭头是线条、方块是实心，同字号下实心块看着会小一圈，
                  17 / 20 才让两个状态在圆里占的分量一致。 */}
              <span className="t-icon-swap" data-state={running ? "b" : "a"}>
                <span className="t-icon" data-icon="a"><Icon name="arrow-up" size={17} /></span>
                <span className="t-icon" data-icon="b"><Icon name="stop" size={20} /></span>
              </span>
            </button>
          </div>
        </div>
        {error ? <div className="composer-error"><Icon name="warning" size={12} /><span>{error}</span><button onClick={() => setError(undefined)} type="button"><Icon name="close" size={11} /></button></div> : null}
        {running && input.trim() ? <div className="composer-hint">按 Enter 将补充要求排入当前会话；右侧按钮可暂停生成</div> : null}
      </div>
    </div>
  );
});

function PermissionMenu({ mode, open, onChange }: { mode: PermissionMode; open: boolean; onChange(mode: PermissionMode): void }): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <div className={`t-dropdown composer-popover permission-menu ${presenceClass(presence.phase)}`} data-origin="bottom-left" role="menu">
      <div className="popover-heading">权限模式</div>
      {permissionOptions.map((option) => (
        <button className={`menu-option${option.mode === mode ? " is-selected" : ""}`} key={option.mode} onClick={() => onChange(option.mode)} role="menuitemradio" type="button">
          <span className="menu-check">{option.mode === mode ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
          {option.risk ? <span className="risk-label">{option.risk}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ModelMenu({
  models,
  currentAlias,
  open,
  onChange
}: {
  models: ModelChoice[];
  currentAlias?: string;
  open: boolean;
  onChange(alias: string, thinking: ThinkingSelection): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  if (!presence.present) return null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = models.reduce<Array<{ key: string; label: string; iconTone: string; models: ModelChoice[] }>>((result, model) => {
    if (normalizedQuery && !`${model.displayName} ${model.model} ${model.provider}`.toLocaleLowerCase().includes(normalizedQuery)) return result;
    const key = `${model.providerType}:${model.provider}`;
    const group = result.find((item) => item.key === key);
    if (group) {
      group.models.push(model);
      return result;
    }
    // Brand marks are keyed by the catalog's `iconTone`, not by provider type:
    // xAI, Z.AI, MiniMax and every relay share providerType "openai-compatible",
    // so resolving the icon from the type alone rendered them all identically.
    const catalog = catalogForConnection({ provider: model.provider, providerType: model.providerType });
    result.push({
      key,
      label: catalog?.label ?? providerLabel(model.provider),
      iconTone: catalog?.iconTone ?? "compatible",
      models: [model]
    });
    return result;
  }, []);
  return (
    <div className={`t-dropdown composer-popover model-menu ${presenceClass(presence.phase)}`} data-origin="bottom-right" role="menu">
      <div className="model-search"><input aria-label="搜索模型" onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型..." value={query} /></div>
      <div className="model-options-scroll">
        {groups.length ? groups.map((group) => (
          <div className="model-group" key={group.key}>
            <div className="model-group-heading"><ProviderBrandGlyph type={group.iconTone} /><span>{group.label}</span></div>
            {group.models.map((model) => (
              <button className={`menu-option model-option${model.alias === currentAlias ? " is-selected" : ""}`} key={model.alias} onClick={() => onChange(model.alias, model.defaultThinking)} role="menuitemradio" title={model.model} type="button">
                <span className="menu-check">{model.alias === currentAlias ? <Icon name="check" size={14} /> : null}</span>
                <strong>{model.displayName}</strong>
              </button>
            ))}
          </div>
        )) : <div className="menu-empty">没有匹配的模型</div>}
      </div>
    </div>
  );
}

function ThinkingMenu({
  current,
  efforts,
  open,
  onChange
}: {
  current: ThinkingSelection;
  efforts: ThinkingSelection[];
  open: boolean;
  onChange(thinking: ThinkingSelection): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <div className={`t-dropdown composer-popover thinking-level-menu ${presenceClass(presence.phase)}`} data-origin="bottom-left" role="menu">
      <div className="popover-heading">思考级别</div>
      {(["off", ...efforts] as ThinkingSelection[]).map((effort) => (
        <button className={`menu-option${effort === current ? " is-selected" : ""}`} key={effort} onClick={() => onChange(effort)} role="menuitemradio" type="button">
          <span className="menu-check">{effort === current ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>{thinkingLabel(effort)}</strong><small>{thinkingDescription(effort)}</small></span>
        </button>
      ))}
    </div>
  );
}

function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find((option) => option.mode === mode)?.label ?? mode;
}

function runModeLabel(mode: InteractiveAgentRunMode): string {
  return mode === "plan" ? "规划" : "聊天";
}

const thinkingLabels: Record<ThinkingSelection, string> = {
  off: "标准",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "较高",
  max: "最高"
};

function thinkingLabel(value: ThinkingSelection): string {
  return thinkingLabels[value] ?? value;
}

function thinkingDescription(value: ThinkingSelection): string {
  return value === "off" ? "不额外要求模型思考，回复最快" : "思考越多越慢，但复杂任务更稳";
}

/**
 * 上下文用量展示值。`usedTokens` 是上一轮实际占用，`maxTokens` 是本模型允许注入的输入预算，
 * 超过它就会触发压缩，所以百分比按这个分母算才有意义。
 */
function formatContextUsage(usage?: ContextUsage): { percent: number; used: string; max: string } | undefined {
  if (!usage || usage.maxTokens <= 0 || usage.usedTokens <= 0) return undefined;
  return {
    percent: Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100)),
    used: usage.usedTokens.toLocaleString("en-US"),
    max: usage.maxTokens.toLocaleString("en-US")
  };
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    kimi: "Kimi",
    moonshot: "Moonshot",
    ollama: "Ollama",
    openai: "OpenAI",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
