/**
 * 桌面端紧凑输入区。
 *
 * 组件只收集输入并调用上层回调，模型切换、权限变更、附件保存和 Agent 执行仍沿用 Biny
 * 原有的数据流。输入框使用原生 textarea 是为了保持单框布局，同时保留 slash
 * command、拖拽附件和运行中 steer/follow-up 行为。
 */
import { memo, useEffect, useRef, useState } from "react";
import type { AgentSessionInfo, InteractiveAgentRunMode } from "../../../../agent/AgentSession.js";
import type { ModelChoice, ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopAttachment, DesktopProject, DesktopSlashCommand } from "../../../protocol.js";
import { DESKTOP_SLASH_COMMANDS } from "../../../protocol.js";
import { catalogForConnection } from "../providerCatalog.js";
import { PermissionMenu } from "./composer/ComposerMenus.js";
import { ModelMenu } from "./composer/ModelMenu.js";
import { thinkingLabel } from "./composer/composerLabels.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";

interface ComposerProps {
  project?: DesktopProject;
  runtimeInfo?: AgentSessionInfo;
  permissionMode: PermissionMode;
  models: ModelChoice[];
  /** 已解析好的上下文用量；取不到真实数字时为空，此时不展示用量。 */
  contextUsage?: ContextUsage;
  running: boolean;
  activeElsewhere: boolean;
  modelSetupRequired: boolean;
  focusToken: number;
  onSend(input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp"): Promise<void>;
  onSlashCommand(command: string): Promise<void>;
  onStop(): Promise<void>;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onConfigureModels(): void;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

type ComposerMenu = "permission" | "model" | "thinking" | null;

export const Composer = memo(function Composer({
  project,
  runtimeInfo,
  permissionMode,
  models,
  contextUsage,
  running,
  activeElsewhere,
  modelSetupRequired,
  focusToken,
  onSend,
  onSlashCommand,
  onStop,
  onPermissionMode,
  onSwitchModel,
  onConfigureModels,
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (!menu) return;
    const isInsideOpenMenu = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".composer-popover")) return true;
      return Boolean(target.closest(`[data-composer-menu="${menu}"]`));
    };
    const close = (event: PointerEvent): void => {
      if (!isInsideOpenMenu(event.target)) setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    const focus = (event: FocusEvent): void => {
      if (!isInsideOpenMenu(event.target)) setMenu(null);
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

  const chooseSlashCommand = (command: DesktopSlashCommand): void => {
    if (command.requiresArgs) {
      setInput(`${command.name} `);
      inputRef.current?.focus();
      return;
    }
    void runSlash(command.name);
  };

  const submit = async (delivery?: "steer" | "followUp"): Promise<void> => {
    const value = input.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!project || !value || busy) return;
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
      await onSend(value, mode, sentAttachments, delivery);
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

  const activeModel = models.find((model) => model.alias === runtimeInfo?.modelAlias);
  const selectedModel = activeModel ?? models[0];
  const currentAlias = activeModel?.alias ?? selectedModel?.alias;
  const currentThinking = runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";
  const selectedModelCatalog = selectedModel
    ? catalogForConnection(
      { provider: selectedModel.provider, providerType: selectedModel.providerType },
      selectedModel.baseUrl
    )
    : undefined;
  const thinkingEfforts = selectedModel?.efforts ?? [];
  const modelName = selectedModel?.displayName ?? runtimeInfo?.modelLabel ?? "GPT-5.6-Luna";
  const usage = formatContextUsage(contextUsage);
  const inputDisabled = activeElsewhere || modelSetupRequired || busy;
  const sendDisabled = running
    ? false
    : (!input.trim() && !attachments.length) || !project || activeElsewhere || modelSetupRequired || busy;
  const placeholder = running ? "可以继续补充要求…" : "hi biny";

  return (
    <div
      className={`composer-container cindy-composer${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      {attachments.length ? (
        <div className="cindy-composer-attachments">
          {attachments.map((attachment, index) => (
            <div className="cindy-attachment-chip" key={`${attachment.path}-${String(index)}`}>
              <Icon name={attachment.mimeType.startsWith("image/") ? "spark" : "file"} size={13} />
              <span>{attachment.name}</span>
              <button aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button"><Icon name="close" size={11} /></button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="cindy-composer-editor">
        {slashMenuOpen ? (
          <div className="composer-popover slash-menu desktop-composer-menu" role="menu">
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
          autoComplete="off"
          className="cindy-composer-input"
          disabled={inputDisabled}
          onChange={(event) => {
            setInput(event.target.value);
            setSlashIndex(0);
            setSlashDismissed(false);
            event.currentTarget.style.height = "auto";
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 128)}px`;
          }}
          onKeyDown={(event) => {
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
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing)) {
                event.preventDefault();
                const selected = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
                if (selected) chooseSlashCommand(selected);
                return;
              }
            }
            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit(running && (event.metaKey || event.ctrlKey) ? "steer" : undefined);
          }}
          placeholder={placeholder}
          ref={inputRef}
          rows={1}
          value={input}
        />
      </div>
      <div className="cindy-composer-footer">
        <div className="cindy-composer-footer-start">
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
          <button aria-label="添加附件" className="cindy-composer-add" disabled={!project || busy || modelSetupRequired} onClick={() => fileInputRef.current?.click()} type="button">
            <Icon name="add" size={15} />
          </button>
          <div className="composer-menu-anchor">
            <button
              className="cindy-permission-pill"
              data-composer-menu="permission"
              disabled={!project || modelSetupRequired}
              onClick={() => setMenu(menu === "permission" ? null : "permission")}
              type="button"
            >
              <Icon name="spark" size={13} />
              <span>{cindyPermissionLabel(permissionMode)}</span>
              <Icon name="chevron" size={11} />
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
          {mode === "plan" ? (
            <button className="cindy-plan-pill" onClick={() => setMode("chat")} type="button">规划</button>
          ) : null}
        </div>
        <div className="cindy-composer-footer-end">
          <div className="composer-menu-anchor">
            <button
              className="cindy-model-pill"
              data-composer-menu="model"
              disabled={modelSetupRequired}
              onClick={() => setMenu(menu === "model" ? null : "model")}
              type="button"
            >
              {selectedModel ? <span className="model-trigger-brand"><ProviderBrandGlyph type={selectedModelCatalog?.iconTone ?? selectedModel.providerType} /></span> : null}
              <span>{modelName}{thinkingEfforts.length ? ` · ${thinkingLabel(currentThinking)}` : " · 高"}</span>
              <Icon name="chevron" size={11} />
            </button>
            <ModelMenu
              currentAlias={currentAlias}
              currentThinking={currentThinking}
              models={models}
              open={menu === "model"}
              onChange={(alias, thinking) => {
                setMenu(null);
                void onSwitchModel(alias, thinking).catch((modelError) => setError(errorMessage(modelError)));
              }}
              onConfigureModels={() => {
                setMenu(null);
                onConfigureModels();
              }}
            />
          </div>
          {usage ? (
            <span className="context-usage" role="status">
              <Icon name="timer" size={12} /><span>{usage.percent}%</span>
              <span className="context-usage-tip">上下文使用量<strong>{usage.used} / {usage.max} tokens</strong></span>
            </span>
          ) : null}
          <button aria-label="语音输入" className="cindy-mic-button" disabled type="button"><Icon name="mic" size={15} /></button>
          <button
            aria-label={running ? "停止运行" : "发送消息"}
            className="cindy-send-button"
            disabled={sendDisabled}
            onClick={() => {
              if (running) void onStop();
              else void submit();
            }}
            type="button"
          >
            <Icon name={running ? "stop" : "arrow-up"} size={running ? 15 : 16} />
          </button>
        </div>
      </div>
      {error ? <div className="cindy-composer-error" role="alert">{error}</div> : null}
      {running && input.trim() ? <div className="composer-hint">按 Enter 将补充要求排入当前会话；⌘ Enter 立即转向</div> : null}
    </div>
  );
});

function cindyPermissionLabel(mode: PermissionMode): string {
  if (mode === "auto") return "自动审批";
  if (mode === "full-access") return "完全访问";
  if (mode === "read-only") return "只读";
  return "每次询问";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
