import { memo, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import { copyToClipboard } from "../copyToClipboard.js";
import { listChangedFiles, type TimelineTool, type TimelineTurn } from "../sessionTimeline.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { ToolActivity } from "./ToolActivity.js";

interface MessageTimelineProps {
  projectId: string;
  turns: TimelineTurn[];
  onPreviewFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, turns, onPreviewFile, onResolvePermission, onRetry, onEditUserMessage, onCreateBranch, onRollbackFiles, onDeleteUserMessage }: MessageTimelineProps): React.JSX.Element {
  return (
    <div className="message-timeline">
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          onCreateBranch={onCreateBranch}
          onDeleteUserMessage={onDeleteUserMessage}
          onEditUserMessage={onEditUserMessage}
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
  onPreviewFile,
  onResolvePermission,
  onRetry,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage
}: {
  projectId: string;
  turn: TimelineTurn;
  onPreviewFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string): void;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
}): React.JSX.Element {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState<string>();
  const summary = useMemo(() => turnSummary(turn), [turn]);
  const running = turn.status === "running" || turn.status === "waiting_permission" || turn.status === "queued";
  const activeTool = turn.tools.find((tool) => tool.id === selectedToolId);
  const hasReasoning = Boolean(turn.reasoningStatus || turn.reasoning || turn.durationMs !== undefined);
  return (
    <article className={`timeline-turn is-${turn.status}`}>
      {turn.user ? (
        <UserMessage
          content={turn.user}
          hasChangedFiles={listChangedFiles(turn).length > 0}
          onCreateBranch={onCreateBranch}
          onDelete={() => onDeleteUserMessage(turn.id)}
          onEdit={() => onEditUserMessage(turn.user)}
          onRegenerate={() => onRetry(turn.user)}
          onRollbackFiles={() => onRollbackFiles(turn)}
        />
      ) : null}
      <div className="agent-response">
        {hasReasoning || turn.tools.length || turn.skills.length ? (
          <ExecutionSummary
            onSelectTool={(toolId) => setSelectedToolId((current) => current === toolId ? undefined : toolId)}
            onToggleReasoning={() => setReasoningOpen((open) => !open)}
            reasoningOpen={reasoningOpen}
            running={running}
            turn={turn}
          />
        ) : running && !turn.assistant ? (
          <div className="reasoning-row is-static"><span className="reasoning-pulse" /><span>{turn.status === "queued" ? "等待上一项任务完成" : "正在处理"}</span></div>
        ) : null}
        {reasoningOpen ? <ReasoningDetail content={turn.reasoning} status={turn.reasoningStatus} /> : null}

        {activeTool ? <div className="selected-tool-detail"><ToolActivity onPreviewFile={onPreviewFile} onResolvePermission={onResolvePermission} projectId={projectId} tool={activeTool} /></div> : null}
        {turn.assistant ? <MarkdownContent content={turn.assistant} onPreviewFile={onPreviewFile} /> : null}

        {turn.assistant ? <AssistantActions content={turn.assistant} timestamp={turn.timestamp} /> : null}

        {!running && turn.status !== "idle" && (turn.status !== "completed" || summary || turn.model) ? (
          <footer className={`run-result is-${turn.status}`}>
            {turn.status !== "completed" ? <>
              <span className="run-result-icon"><Icon name={turn.status === "failed" ? "warning" : "stop"} size={13} /></span>
              <span className="run-result-label">{runStatusLabel(turn.status)}</span>
            </> : null}
            {summary ? <span className="run-result-summary">{summary}</span> : null}
            {turn.model ? <span className="run-model">{turn.model.label}</span> : null}
          </footer>
        ) : null}

        {turn.error && (turn.status === "failed" || turn.status === "aborted") ? (
          <section className="run-error">
            <button className="run-error-heading" onClick={() => setErrorOpen(!errorOpen)} type="button"><span>{turn.status === "failed" ? "执行失败" : "任务已中止"}</span><Icon name="chevron" size={12} /></button>
            {errorOpen ? <pre><code>{turn.error}</code></pre> : null}
            <div className="run-error-actions">
              {turn.status === "failed" && turn.user ? <button onClick={() => onRetry(turn.user)} type="button">重试</button> : null}
              <button onClick={() => void copyToClipboard(turn.error ?? "")} type="button">复制错误</button>
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
});

function UserMessage({
  content,
  hasChangedFiles,
  onCreateBranch,
  onDelete,
  onEdit,
  onRegenerate,
  onRollbackFiles
}: {
  content: string;
  hasChangedFiles: boolean;
  onCreateBranch(): void;
  onDelete(): void;
  onEdit(): void;
  onRegenerate(): void;
  onRollbackFiles(): void;
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

function ExecutionSummary({
  turn,
  running,
  reasoningOpen,
  onToggleReasoning,
  onSelectTool
}: {
  turn: TimelineTurn;
  running: boolean;
  reasoningOpen: boolean;
  onToggleReasoning(): void;
  onSelectTool(toolId: string): void;
}): React.JSX.Element {
  const toolEntries = useMemo(() => uniqueToolEntries(turn.tools), [turn.tools]);
  const [openMenu, setOpenMenu] = useState<"tools" | "skills">();
  return (
    <div className="execution-summary">
      {turn.reasoningStatus || turn.reasoning || turn.durationMs !== undefined ? (
        <button aria-expanded={reasoningOpen} className={`execution-summary-button${reasoningOpen ? " is-open" : ""}`} onClick={() => { setOpenMenu(undefined); onToggleReasoning(); }} type="button">
          {running ? <span className="reasoning-pulse" /> : <Icon name="brain" size={14} />}
          <span>{thinkingLabel(turn, running)}</span>
          <span className={`reasoning-chevron${reasoningOpen ? " is-expanded" : ""}`}><Icon name="chevron" size={12} /></span>
        </button>
      ) : null}
      {toolEntries.length ? <SummaryMenu icon="wrench" label={`${String(toolEntries.length)} 个工具`} title="自动选择的工具：" items={toolEntries} onSelect={onSelectTool} open={openMenu === "tools"} onToggle={() => setOpenMenu((current) => current === "tools" ? undefined : "tools")} onClose={() => setOpenMenu(undefined)} /> : null}
      {turn.skills.length ? <SummaryMenu icon="wand" label={`${String(turn.skills.length)} 个技能`} title="自动选择的技能：" items={turn.skills.map((label) => ({ key: label, label }))} open={openMenu === "skills"} onToggle={() => setOpenMenu((current) => current === "skills" ? undefined : "skills")} onClose={() => setOpenMenu(undefined)} /> : null}
    </div>
  );
}

function SummaryMenu({
  icon,
  label,
  title,
  items,
  onSelect,
  open,
  onToggle,
  onClose
}: {
  icon: "wand" | "wrench";
  label: string;
  title: string;
  items: SummaryItem[];
  onSelect?: (toolId: string) => void;
  open: boolean;
  onToggle(): void;
  onClose(): void;
}): React.JSX.Element {
  return (
    <div className={`summary-menu${open ? " is-open" : ""}`}>
      <button aria-expanded={open} className="execution-summary-button" onClick={onToggle} type="button">
        <Icon name={icon} size={14} />
        <span>{label}</span>
        <span className={`reasoning-chevron${open ? " is-expanded" : ""}`}><Icon name="chevron" size={12} /></span>
      </button>
      {open ? (
        <div className="summary-popover">
          <div className="summary-popover-title">{title}</div>
          <ul>
            {items.map((item) => (
              <li key={item.key}>
                {onSelect && item.toolId ? <button className="summary-popover-item" onClick={() => { onSelect(item.toolId ?? ""); onClose(); }} type="button"><span className="summary-popover-bullet">•</span><span>{item.label}</span></button> : <span className="summary-popover-item"><span className="summary-popover-bullet">•</span><span>{item.label}</span></span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

interface SummaryItem {
  key: string;
  label: string;
  toolId?: string;
}

function uniqueToolEntries(tools: TimelineTool[]): SummaryItem[] {
  const entries = new Map<string, SummaryItem>();
  for (const tool of tools) {
    if (!entries.has(tool.tool)) entries.set(tool.tool, { key: tool.tool, label: executionToolLabel(tool.tool), toolId: tool.id });
  }
  return [...entries.values()];
}

function executionToolLabel(tool: string): string {
  if (tool === "run_command") return "Bash";
  if (tool === "invoke_skill" || tool === "skill_call") return "技能调用";
  return tool;
}

function ReasoningDetail({ content, status }: { content: string; status?: string }): React.JSX.Element {
  const text = content.trim() || status || "暂无可展开的思考内容";
  return <div className="reasoning-detail"><div className="reasoning-detail-copy">{text}</div></div>;
}

function thinkingLabel(turn: TimelineTurn, running: boolean): string {
  const duration = turn.reasoningDurationMs ?? (!running ? turn.durationMs : undefined);
  if (duration !== undefined) return `思考了 ${formatThinkingDuration(duration)}`;
  return turn.reasoningStatus ?? "正在思考";
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
