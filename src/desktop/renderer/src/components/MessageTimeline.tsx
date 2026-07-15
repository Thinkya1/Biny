import { memo, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { Icon } from "./Icon.js";
import { ToolActivity } from "./ToolActivity.js";

interface MessageTimelineProps {
  projectId: string;
  turns: TimelineTurn[];
  onOpenFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
}

export const MessageTimeline = memo(function MessageTimeline({ projectId, turns, onOpenFile, onResolvePermission, onRetry }: MessageTimelineProps): React.JSX.Element {
  return (
    <div className="message-timeline">
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          onOpenFile={onOpenFile}
          onResolvePermission={onResolvePermission}
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
  onOpenFile,
  onResolvePermission,
  onRetry
}: {
  projectId: string;
  turn: TimelineTurn;
  onOpenFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
}): React.JSX.Element {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const summary = useMemo(() => turnSummary(turn), [turn]);
  const running = turn.status === "running" || turn.status === "waiting_permission" || turn.status === "queued";
  return (
    <article className={`timeline-turn is-${turn.status}`}>
      {turn.user ? <div className="user-task"><div className="task-kicker">任务</div><div className="user-copy">{turn.user}</div></div> : null}
      <div className="agent-response">
        {turn.reasoningStatus ? (
          <button className="reasoning-row" onClick={() => setReasoningOpen(!reasoningOpen)} type="button">
            {running ? <span className="reasoning-pulse" /> : <Icon name="spark" size={13} />}
            <span>{turn.reasoningStatus}</span>
            <span className={`reasoning-chevron${reasoningOpen ? " is-expanded" : ""}`}><Icon name="chevron" size={12} /></span>
          </button>
        ) : running && !turn.assistant && !turn.tools.length ? (
          <div className="reasoning-row is-static"><span className="reasoning-pulse" /><span>{turn.status === "queued" ? "等待上一项任务完成" : "正在处理"}</span></div>
        ) : null}
        {reasoningOpen ? <div className="reasoning-detail">这里只显示 Biny 公开的执行状态，不展示模型的私有思维链。</div> : null}

        {turn.assistant ? <MarkdownContent content={turn.assistant} onOpenFile={onOpenFile} /> : null}
        {turn.tools.length ? (
          <div className="tool-list">
            {turn.tools.map((tool) => (
              <ToolActivity
                key={tool.id}
                onOpenFile={onOpenFile}
                onResolvePermission={onResolvePermission}
                projectId={projectId}
                tool={tool}
              />
            ))}
          </div>
        ) : null}

        {!running && turn.status !== "idle" ? (
          <footer className={`run-result is-${turn.status}`}>
            <span className="run-result-icon"><Icon name={turn.status === "completed" ? "check" : turn.status === "failed" ? "warning" : "stop"} size={13} /></span>
            <span className="run-result-label">{runStatusLabel(turn.status)}</span>
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
              <button onClick={() => void navigator.clipboard.writeText(turn.error ?? "")} type="button">复制错误</button>
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
});

function MarkdownContent({ content, onOpenFile }: { content: string; onOpenFile(path: string): void }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <Markdown
        components={{
          a({ href, children }) {
            return <a href={href} onClick={(event) => { if (!href?.startsWith("http")) event.preventDefault(); }} rel="noreferrer" target="_blank">{children}</a>;
          },
          code({ className, children }) {
            const text = String(children).replace(/\n$/, "");
            const block = Boolean(className) || text.includes("\n");
            if (block) return <code className={className}>{children}</code>;
            const isPath = looksLikePath(text);
            return <code className={isPath ? "inline-path" : undefined} onClick={() => { if (isPath) onOpenFile(text); }}>{children}</code>;
          },
          pre({ children }) {
            const text = extractText(children);
            return (
              <div className="markdown-code-block">
                <button aria-label="复制代码" onClick={() => void navigator.clipboard.writeText(text)} type="button"><Icon name="copy" size={12} /></button>
                <pre>{children}</pre>
              </div>
            );
          }
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </Markdown>
    </div>
  );
}

function turnSummary(turn: TimelineTurn): string {
  const changedFiles = new Set(turn.tools.filter((tool) => tool.path && (tool.tool.includes("write") || tool.tool.includes("edit"))).map((tool) => tool.path));
  const commands = turn.tools.filter((tool) => tool.command || tool.display?.kind === "command").length;
  const parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push(formatDuration(turn.durationMs));
  if (turn.usage?.totalTokens !== undefined) parts.push(`${turn.usage.totalTokens.toLocaleString()} tokens`);
  if (changedFiles.size) parts.push(`${String(changedFiles.size)} 个文件`);
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
