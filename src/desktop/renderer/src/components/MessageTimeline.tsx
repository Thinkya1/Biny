import { memo, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { listChangedFiles, type TimelineReasoningStep, type TimelineStep, type TimelineTurn } from "../sessionTimeline.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { ToolActivity } from "./ToolActivity.js";

interface MessageTimelineProps {
  projectId: string;
  sessionId?: string;
  turns: TimelineTurn[];
  onPreviewFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, sessionId, turns, onPreviewFile, onResolvePermission, onRetry, onEditUserMessage, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  const [editing, setEditing] = useState<{ turnId: string; value: string; userMessageIndex: number }>();

  const startEditing = (turn: TimelineTurn): void => {
    if (turn.userMessageIndex === undefined) return;
    setEditing({ turnId: turn.id, value: turn.user, userMessageIndex: turn.userMessageIndex });
  };

  const submitEditing = async (): Promise<void> => {
    if (!editing || !sessionId) return;
    await onEditUserMessage(editing.value, editing.userMessageIndex);
    setEditing(undefined);
  };

  return (
    <div className="message-timeline">
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          onCreateBranch={onCreateBranch}
          onDeleteUserMessage={onDeleteUserMessage}
          editing={editing?.turnId === turn.id ? editing : undefined}
          onCancelEdit={() => setEditing(undefined)}
          onChangeEdit={(value) => setEditing((current) => current?.turnId === turn.id ? { ...current, value } : current)}
          onEditUserMessage={() => startEditing(turn)}
          onSubmitEdit={submitEditing}
          onPreviewFile={onPreviewFile}
          onResolvePermission={onResolvePermission}
          onRollbackFiles={onRollbackFiles}
          onRetry={onRetry}
          projectId={projectId}
          turn={turn}
        />
      ))}
    </div>
  );
});

const Turn = memo(function Turn({
  projectId,
  turn,
  editing,
  onPreviewFile,
  onResolvePermission,
  onRetry,
  onCancelEdit,
  onChangeEdit,
  onEditUserMessage,
  onSubmitEdit,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  projectId: string;
  turn: TimelineTurn;
  editing?: { value: string };
  onPreviewFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onCancelEdit(): void;
  onChangeEdit(value: string): void;
  onEditUserMessage(): void;
  onSubmitEdit(): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(() => new Set());
  const [errorOpen, setErrorOpen] = useState(false);
  const summary = useMemo(() => turnSummary(turn), [turn]);
  const running = turn.status === "running" || turn.status === "waiting_permission" || turn.status === "queued";
  const executionSteps = turn.steps.length ? turn.steps : fallbackExecutionSteps(turn);
  const toggleReasoning = (stepId: string): void => {
    setExpandedReasoning((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };
  return (
    <article className={`timeline-turn is-${turn.status}`}>
      {turn.user ? (
        <UserMessage
          content={turn.user}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          editing={editing}
          onCreateBranch={onCreateBranch}
          onDelete={() => onDeleteUserMessage(turn.id)}
          onCancelEdit={onCancelEdit}
          onChangeEdit={onChangeEdit}
          onEdit={onEditUserMessage}
          onRegenerate={() => onRetry(turn.user)}
          onRollbackFiles={() => onRollbackFiles(turn)}
          onSubmitEdit={onSubmitEdit}
        />
      ) : null}
      <div className="agent-response">
        {executionSteps.length || turn.skills.length ? (
          <ExecutionTimeline
            expandedReasoning={expandedReasoning}
            onPreviewFile={onPreviewFile}
            onResolvePermission={onResolvePermission}
            onToggleReasoning={toggleReasoning}
            projectId={projectId}
            running={running}
            steps={executionSteps}
            skills={turn.skills}
          />
        ) : running && !turn.assistant ? (
          <div className="reasoning-row is-static"><span className="reasoning-pulse" /><span>{turn.status === "queued" ? "等待上一项任务完成" : "正在处理"}</span></div>
        ) : null}
        {!executionSteps.some((step) => step.kind === "assistant") && turn.assistant ? <MarkdownContent content={turn.assistant} onPreviewFile={onPreviewFile} /> : null}

        {turn.assistant ? <AssistantActions content={turn.assistant} timestamp={turn.timestamp} /> : null}

        {!running && turn.status !== "idle" && (turn.status !== "completed" || summary || turn.model) ? (
          <footer className={`run-result is-${turn.status}`}>
            {turn.status !== "completed" ? <>
              <span className="run-result-icon"><Icon name={turn.status === "failed" || turn.status === "incomplete" ? "warning" : "stop"} size={13} /></span>
              <span className="run-result-label">{runStatusLabel(turn.status)}</span>
            </> : null}
            {summary ? <span className="run-result-summary">{summary}</span> : null}
            {turn.model ? <span className="run-model">{turn.model.label}</span> : null}
          </footer>
        ) : null}

        {turn.error && (turn.status === "failed" || turn.status === "incomplete" || turn.status === "aborted") ? (
          <section className="run-error">
            <button className="run-error-heading" onClick={() => setErrorOpen(!errorOpen)} type="button"><span>{turn.status === "failed" ? "执行失败" : turn.status === "incomplete" ? "任务未完成" : "任务已中止"}</span><Icon name="chevron" size={12} /></button>
            {errorOpen ? <pre><code>{turn.error}</code></pre> : null}
            <div className="run-error-actions">
              {(turn.status === "failed" || turn.status === "incomplete") && turn.user ? <button onClick={() => onRetry(turn.user)} type="button">重试</button> : null}
              <button onClick={() => void copyToClipboard(turn.error ?? "")} type="button">复制错误</button>
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
});

function fallbackExecutionSteps(turn: TimelineTurn): TimelineStep[] {
  if (!turn.reasoningStatus && !turn.reasoning && turn.durationMs === undefined) return [];
  return [{
    kind: "reasoning",
    id: `${turn.id}:reasoning:fallback`,
    content: turn.reasoning,
    status: turn.reasoningStatus,
    durationMs: turn.reasoningDurationMs ?? (turn.status === "running" || turn.status === "waiting_permission" || turn.status === "queued" ? undefined : turn.durationMs),
    completed: turn.status !== "running" && turn.status !== "waiting_permission" && turn.status !== "queued"
  }];
}

function ExecutionTimeline({
  expandedReasoning,
  onPreviewFile,
  onResolvePermission,
  onToggleReasoning,
  projectId,
  running,
  skills,
  steps
}: {
  expandedReasoning: Set<string>;
  onPreviewFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onToggleReasoning(stepId: string): void;
  projectId: string;
  running: boolean;
  skills: string[];
  steps: TimelineStep[];
}): React.JSX.Element {
  return (
    <div className="execution-timeline">
      {skills.length ? (
        <div className="execution-skills">
          <Icon name="wand" size={14} />
          <span>使用 {String(skills.length)} 个技能</span>
          <span className="execution-skills-list">{skills.join(" · ")}</span>
        </div>
      ) : null}
      {steps.map((step) => {
        if (step.kind === "reasoning") {
          return <ReasoningStepView key={step.id} expanded={expandedReasoning.has(step.id)} onToggle={() => onToggleReasoning(step.id)} running={running} step={step} />;
        }
        if (step.kind === "tool") {
          return <div className="execution-tool-step" key={step.id}><ToolActivity onPreviewFile={onPreviewFile} onResolvePermission={onResolvePermission} projectId={projectId} tool={step.tool} /></div>;
        }
        return <div className="execution-assistant-step" key={step.id}><MarkdownContent content={step.content} onPreviewFile={onPreviewFile} /></div>;
      })}
    </div>
  );
}

function ReasoningStepView({ expanded, onToggle, running, step }: {
  expanded: boolean;
  onToggle(): void;
  running: boolean;
  step: TimelineReasoningStep;
}): React.JSX.Element {
  const text = step.content.trim() || step.status || "暂无可展开的思考内容";
  const label = step.durationMs !== undefined
    ? `思考了 ${formatThinkingDuration(step.durationMs)}`
    : step.completed
      ? "深度思考"
      : step.status ?? (running ? "正在思考" : "深度思考");
  return (
    <section className={`execution-reasoning${expanded ? " is-open" : ""}`}>
      <button aria-expanded={expanded} className="execution-reasoning-button" onClick={onToggle} type="button">
        {running && !step.completed ? <span className="reasoning-pulse" /> : <Icon name="brain" size={14} />}
        <span>{label}</span>
        <span className={`reasoning-chevron${expanded ? " is-expanded" : ""}`}><Icon name="chevron" size={12} /></span>
      </button>
      {expanded ? <div className="reasoning-detail"><div className="reasoning-detail-copy">{text}</div></div> : null}
    </section>
  );
}

function UserMessage({
  content,
  hasChangedFiles,
  editing,
  onCreateBranch,
  onDelete,
  onEdit,
  onCancelEdit,
  onChangeEdit,
  onRegenerate,
  onRollbackFiles,
  onSubmitEdit
}: {
  content: string;
  hasChangedFiles: boolean;
  editing?: { value: string };
  onCreateBranch(): void;
  onDelete(): void;
  onEdit(): void;
  onCancelEdit(): void;
  onChangeEdit(value: string): void;
  onRegenerate(): void;
  onRollbackFiles(): void;
  onSubmitEdit(): Promise<void>;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (editing) {
    return (
      <div className="user-message is-editing">
        <InlineUserMessageEditor
          value={editing.value}
          onCancel={onCancelEdit}
          onChange={onChangeEdit}
          onSubmit={onSubmitEdit}
        />
      </div>
    );
  }

  const closeMenu = (): void => setMenuOpen(false);
  return (
    <div className="user-message">
      <div className="user-bubble">{content}</div>
      <div className={`user-message-actions${menuOpen ? " is-open" : ""}`} ref={actionsRef}>
        <button aria-label="复制消息" className="user-message-action" onClick={() => copyText(content)} title="复制消息" type="button"><Icon name="copy" size={13} /></button>
        <button aria-label="重新生成" className="user-message-action" onClick={onRegenerate} title="重新生成" type="button"><Icon name="refresh" size={13} /></button>
        <button aria-label="编辑消息" className="user-message-action" onClick={onEdit} title="编辑消息" type="button"><Icon name="edit" size={13} /></button>
        <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="更多消息操作" className="user-message-action" onClick={() => setMenuOpen((open) => !open)} title="更多" type="button"><Icon name="more" size={13} /></button>
        {menuOpen ? (
          <div className="user-message-menu" role="menu">
            <button className="user-message-menu-item" onClick={() => { copyText(content); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为 Markdown</span></button>
            <button className="user-message-menu-item" onClick={() => { copyText(plainTextFromMarkdown(content)); closeMenu(); }} role="menuitem" type="button"><Icon name="copy" size={14} /><span>复制为纯文本</span></button>
            <button className="user-message-menu-item" onClick={() => { onCreateBranch(); closeMenu(); }} role="menuitem" type="button"><Icon name="branch" size={14} /><span>创建分支</span></button>
            <button className="user-message-menu-item" disabled={!hasChangedFiles} onClick={() => { onRollbackFiles(); closeMenu(); }} role="menuitem" title={hasChangedFiles ? "回滚本条消息产生的文件修改" : "当前消息没有可回滚的文件修改"} type="button"><Icon name="arrow-left" size={14} /><span>回滚文件</span></button>
            <div className="user-message-menu-separator" />
            <button className="user-message-menu-item is-danger" onClick={() => { onDelete(); closeMenu(); }} role="menuitem" type="button"><Icon name="trash" size={14} /><span>删除消息</span></button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InlineUserMessageEditor({ value, onCancel, onChange, onSubmit }: {
  value: string;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const initialValueRef = useRef(value);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(initialValueRef.current.length, initialValueRef.current.length);
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="user-message-editor">
      <textarea
        aria-label="编辑用户消息"
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onCompositionEnd={() => { composingRef.current = false; }}
        onCompositionStart={() => { composingRef.current = true; }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || composingRef.current || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
        ref={textareaRef}
        rows={1}
        value={value}
      />
      {error ? <div className="user-message-editor-error"><Icon name="warning" size={12} /><span>{error}</span></div> : null}
      <div className="user-message-editor-actions">
        <button disabled={busy} onClick={onCancel} type="button">取消</button>
        <button className="is-primary" disabled={busy || !value.trim()} onClick={() => void submit()} type="button">{busy ? "发送中…" : "发送"}</button>
      </div>
    </div>
  );
}

function copyText(content: string): void {
  void copyToClipboard(content);
}

function plainTextFromMarkdown(content: string): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .trim();
}

function formatThinkingDuration(durationMs: number): string {
  const seconds = durationMs / 1_000;
  const precision = seconds < 10 ? 3 : seconds < 60 ? 1 : 0;
  return `${seconds.toFixed(precision)} 秒`;
}

function MarkdownContent({ content, onPreviewFile }: { content: string; onPreviewFile(path: string): void }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <Markdown
        components={{
          a({ href, children }) {
            const path = localPathFromHref(href);
            return <a href={href} onClick={path ? (event) => { event.preventDefault(); onPreviewFile(path); } : undefined} rel="noreferrer" target={path ? undefined : "_blank"} title={path ? "在右侧预览" : undefined}>{children}</a>;
          },
          code({ className, children }) {
            const text = String(children).replace(/\n$/, "");
            const block = Boolean(className) || text.includes("\n");
            if (block) return <code className={className}>{children}</code>;
            const isPath = looksLikePath(text);
            return <code className={isPath ? "inline-path" : undefined} onClick={() => { if (isPath) onPreviewFile(stripLineSuffix(text)); }} title={isPath ? "在右侧预览" : undefined}>{children}</code>;
          },
          pre({ children }) {
            return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
          }
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </Markdown>
    </div>
  );
}

function MarkdownCodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const fallback = extractText(children).replace(/\n$/, "");
  return (
    <div className="markdown-code-block">
      <CopyButton
        className="copy-button markdown-code-copy"
        label="复制代码"
        resolveValue={() => {
          const live = preRef.current?.innerText ?? preRef.current?.textContent ?? "";
          return (live || fallback).replace(/\n$/, "");
        }}
        value={fallback}
      />
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

function localPathFromHref(href?: string): string | undefined {
  if (!href || href.startsWith("#") || (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href) && !href.startsWith("file://"))) return undefined;
  const encoded = href.startsWith("file://") ? href.slice("file://".length) : href;
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // Keep malformed local paths usable instead of breaking the whole message.
  }
  return looksLikePath(decoded) ? stripLineSuffix(decoded) : undefined;
}

function stripLineSuffix(path: string): string {
  return path.replace(/(?::\d+){1,2}$/, "");
}

function AssistantActions({ content, timestamp }: { content: string; timestamp?: string }): React.JSX.Element {
  return (
    <div className="assistant-actions">
      <CopyButton className="assistant-action" label="复制回复" size={13} value={content} />
      {timestamp ? <time className="assistant-time" dateTime={timestamp}>{formatMessageTime(timestamp)}</time> : null}
    </div>
  );
}

function turnSummary(turn: TimelineTurn): string {
  const changedFiles = listChangedFiles(turn);
  const commands = turn.tools.filter((tool) => tool.command || tool.display?.kind === "command").length;
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(formatDuration(turn.durationMs));
  if (turn.usage?.totalTokens !== undefined) parts.push(`${turn.usage.totalTokens.toLocaleString()} tokens`);
  if (changedFiles.length) parts.push(`${String(changedFiles.length)} 个文件`);
  if (commands) parts.push(`${String(commands)} 条命令`);
  return parts.join(" · ");
}

function runStatusLabel(status: TimelineTurn["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "incomplete") return "未完成";
  if (status === "aborted") return "已中止";
  if (status === "failed") return "执行失败";
  return "部分完成";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
}

function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function looksLikePath(value: string): boolean {
  return !value.includes(" ") && (/^(?:\.\/|\.\.\/|\/|[\w.-]+\/)/.test(value) || /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(value));
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}
