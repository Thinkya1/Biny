import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentRunMode, AgentSessionInfo } from "../../../../agent/AgentSession.js";
import type { ModelChoice, ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopAttachment, DesktopProject } from "../../../protocol.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { Icon } from "./Icon.js";

interface ComposerProps {
  project?: DesktopProject;
  sessionId?: string;
  runtimeInfo?: AgentSessionInfo;
  permissionMode: PermissionMode;
  models: ModelChoice[];
  running: boolean;
  activeElsewhere: boolean;
  focusToken: number;
  onOpenProject(): void;
  onSend(input: string, mode: AgentRunMode, attachments: DesktopAttachment[]): Promise<void>;
  onStop(): Promise<void>;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveAttachment(file: File): Promise<DesktopAttachment>;
}

type ComposerMenu = "permission" | "model" | null;

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
  running,
  activeElsewhere,
  focusToken,
  onOpenProject,
  onSend,
  onStop,
  onPermissionMode,
  onSwitchModel,
  onSaveAttachment
}: ComposerProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AgentRunMode>("chat");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (focusToken) textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent): void => {
      if (composerRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${String(Math.min(176, Math.max(54, textarea.scrollHeight)))}px`;
  }, [input]);

  const submit = async (): Promise<void> => {
    const value = input.trim();
    if (!project || !value || busy || activeElsewhere) return;
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
    : activeElsewhere
      ? "另一个会话正在运行；切回后可继续补充"
      : running
        ? "可以继续补充要求"
        : "描述你想完成的任务";
  const selectedModel = models.find((model) => model.alias === runtimeInfo?.modelAlias) ?? models[0];
  const currentAlias = runtimeInfo?.modelAlias ?? selectedModel?.alias;
  const currentThinking = runtimeInfo?.thinking ?? selectedModel?.defaultThinking ?? "off";

  return (
    <div
      className={`composer-shell${running ? " is-running" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
      ref={composerRef}
    >
      {project ? (
        <div className="composer-context">
          <button className="context-segment" onClick={onOpenProject} type="button"><Icon name="folder" size={13} /><span>{project.name}</span></button>
          <span className="context-separator">·</span>
          <span className="context-segment is-static">本地</span>
          {project.branch ? <><span className="context-separator">·</span><span className="context-segment is-static"><Icon name="branch" size={12} /><span>{project.branch}</span></span></> : null}
          {project.dirty ? <span className="workspace-dirty" title="工作区有未提交修改">有修改</span> : null}
        </div>
      ) : null}

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

      <textarea
        aria-label="任务输入"
        disabled={!project || activeElsewhere}
        onChange={(event) => setInput(event.target.value)}
        onCompositionEnd={() => { composingRef.current = false; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || composingRef.current || event.nativeEvent.isComposing) return;
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
          <button aria-label="添加附件" className="composer-icon-button" disabled={!project || busy} onClick={() => fileInputRef.current?.click()} type="button"><Icon name="paperclip" /></button>
          <div className="composer-menu-anchor">
            <button className="composer-select" disabled={!project} onClick={() => setMenu(menu === "permission" ? null : "permission")} type="button">
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
          <button className={`mode-toggle${mode === "plan" ? " is-active" : ""}`} onClick={() => setMode(mode === "chat" ? "plan" : "chat")} title="规划模式只影响下一次运行" type="button">{mode === "plan" ? "规划" : "聊天"}</button>
        </div>
        <div className="composer-actions-right">
          <div className="composer-menu-anchor">
            <button className="model-trigger" disabled={!project || !models.length} onClick={() => setMenu(menu === "model" ? null : "model")} type="button">
              <span>{runtimeInfo?.modelLabel ?? selectedModel?.displayName ?? "选择模型"}</span>
              {runtimeInfo?.reasoningLabel && runtimeInfo.reasoningLabel !== "Off" ? <small>{runtimeInfo.reasoningLabel}</small> : null}
              <Icon name="chevron" size={12} />
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
            />
          </div>
          <button
            aria-label={running ? "停止任务" : "发送任务"}
            className={`send-button${running ? " is-stop" : ""}`}
            disabled={running ? false : !input.trim() || !project || busy || activeElsewhere}
            onClick={() => { if (running) void onStop(); else void submit(); }}
            title={running ? "停止当前任务" : sessionId ? "发送" : "创建任务并发送"}
            type="button"
          >
            <span className="t-icon-swap" data-state={running ? "b" : "a"}>
              <span className="t-icon" data-icon="a"><Icon name="arrow-up" size={15} /></span>
              <span className="t-icon" data-icon="b"><Icon name="stop" size={15} /></span>
            </span>
          </button>
        </div>
      </div>
      {error ? <div className="composer-error"><Icon name="warning" size={12} /><span>{error}</span><button onClick={() => setError(undefined)} type="button"><Icon name="close" size={11} /></button></div> : null}
      {running && input.trim() ? <div className="composer-hint">按 Enter 将补充要求排入当前会话；右侧按钮可停止</div> : null}
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
        <button className="menu-option" key={option.mode} onClick={() => onChange(option.mode)} role="menuitemradio" type="button">
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
  currentThinking,
  open,
  onChange
}: {
  models: ModelChoice[];
  currentAlias?: string;
  currentThinking: ThinkingSelection;
  open: boolean;
  onChange(alias: string, thinking: ThinkingSelection): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  const current = models.find((model) => model.alias === currentAlias);
  const efforts: ThinkingSelection[] = current ? ["off", ...current.efforts] : ["off"];
  return (
    <div className={`t-dropdown composer-popover model-menu ${presenceClass(presence.phase)}`} data-origin="bottom-right" role="menu">
      <div className="popover-heading">模型</div>
      {models.length ? models.map((model) => (
        <button className="menu-option model-option" key={model.alias} onClick={() => onChange(model.alias, model.defaultThinking)} role="menuitemradio" type="button">
          <span className="menu-check">{model.alias === currentAlias ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>{model.displayName}</strong><small>{model.provider} · {model.model}</small></span>
          <span className="capability-label">{toolCapabilityLabel(model.supportsTools)}</span>
        </button>
      )) : <div className="menu-empty">当前配置中没有可用模型</div>}
      {current && efforts.length > 1 ? (
        <div className="reasoning-control">
          <div><span>推理强度</span><small>只影响后续运行</small></div>
          <div className="segmented-control">
            {efforts.map((effort) => (
              <button className={effort === currentThinking ? "is-selected" : ""} key={effort} onClick={() => onChange(current.alias, effort)} type="button">{thinkingLabel(effort)}</button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find((option) => option.mode === mode)?.label ?? mode;
}

function thinkingLabel(value: ThinkingSelection): string {
  if (value === "high") return "高";
  if (value === "max") return "最高";
  return "关闭";
}

function toolCapabilityLabel(supportsTools: boolean | undefined): string {
  if (supportsTools === true) return "支持工具";
  if (supportsTools === false) return "不支持工具";
  return "工具能力未声明";
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
