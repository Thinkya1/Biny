import { memo, useMemo, useState } from "react";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { TimelineCommand, TimelineTool } from "../sessionTimeline.js";
import { Icon, type IconName } from "./Icon.js";

interface ToolActivityProps {
  projectId: string;
  tool: TimelineTool;
  onOpenFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}

export const ToolActivity = memo(function ToolActivity({ projectId, tool, onOpenFile, onResolvePermission }: ToolActivityProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(tool.status === "running" || tool.status === "failed" || Boolean(tool.permission && !tool.permission.resolved));
  const [resolving, setResolving] = useState(false);
  const command = useMemo(() => commandDetails(tool), [tool]);
  const diff = useMemo(() => tool.diff ? analyzeDiff(tool.diff) : undefined, [tool.diff]);
  const summary = toolSummary(tool, command, diff);

  const resolve = async (result: PermissionResult): Promise<void> => {
    if (!tool.permission || resolving) return;
    setResolving(true);
    try {
      await onResolvePermission(tool.permission.requestId, result);
    } finally {
      setResolving(false);
    }
  };

  return (
    <article className={`tool-activity is-${tool.status}`} data-project-id={projectId}>
      <button aria-expanded={expanded} className="tool-heading" onClick={() => setExpanded(!expanded)} type="button">
        <span className="tool-icon"><Icon name={toolIcon(tool)} size={14} /></span>
        <span className="tool-name">{toolLabel(tool.tool)}</span>
        <span className="tool-summary">{summary}</span>
        <ToolStatus status={tool.status} />
        {tool.durationMs !== undefined ? <span className="tool-duration">{formatDuration(tool.durationMs)}</span> : null}
        <span className={`tool-disclosure${expanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span>
      </button>
      {expanded ? (
        <div className="tool-details">
          {tool.permission ? (
            <PermissionCard disabled={resolving} permission={tool.permission} onResolve={resolve} />
          ) : null}
          {command ? <CommandLog command={command} running={tool.status === "running"} /> : null}
          {diff && tool.diff ? <DiffView diff={tool.diff} info={diff} onOpenFile={onOpenFile} /> : null}
          {tool.path && !diff ? (
            <button className="file-path-row" onClick={() => onOpenFile(tool.path ?? "")} type="button"><Icon name="file" size={13} /><span>{tool.path}</span></button>
          ) : null}
          {!command && !diff ? <ToolPayload tool={tool} /> : null}
          {tool.error ? <pre className="tool-error-output">{tool.error}</pre> : null}
        </div>
      ) : null}
    </article>
  );
});

function PermissionCard({
  permission,
  disabled,
  onResolve
}: {
  permission: NonNullable<TimelineTool["permission"]>;
  disabled: boolean;
  onResolve(result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const request = permission.request;
  const alwaysScope = request.command ? "command" : request.targetPath ? "path" : "tool";
  if (permission.resolved) {
    return (
      <div className={`permission-card is-resolved${permission.approved ? " is-approved" : " is-denied"}`}>
        <Icon name={permission.approved ? "check" : "close"} size={15} />
        <span>{permission.approved ? "已允许" : "已拒绝"}{permission.message ? `：${permission.message}` : ""}</span>
      </div>
    );
  }
  return (
    <section className="permission-card">
      <div className="permission-title"><Icon name="warning" size={16} /><strong>{request.title}</strong><span className={`risk-badge is-${request.riskLevel}`}>{riskLabel(request.riskLevel)}</span></div>
      <p>{request.details}</p>
      {request.command ? <pre className="permission-preview"><code>{request.command}</code></pre> : null}
      {request.targetPath ? <div className="permission-target"><Icon name="file" size={13} /><span>{request.targetPath}</span></div> : null}
      {request.preview && !request.command ? <pre className="permission-preview"><code>{request.preview}</code></pre> : null}
      {request.reason ? <p className="permission-reason">{request.reason}</p> : null}
      <div className="permission-actions">
        <button disabled={disabled} onClick={() => void onResolve({ approved: false, scope: "once", message: "Denied in Biny desktop." })} type="button">拒绝</button>
        <button disabled={disabled} onClick={() => void onResolve({ approved: true, scope: alwaysScope })} type="button">始终允许同类操作</button>
        <button className="is-primary" disabled={disabled} onClick={() => void onResolve({ approved: true, scope: "once" })} type="button">允许一次</button>
      </div>
    </section>
  );
}

function CommandLog({ command, running }: { command: TimelineCommand; running: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const output = [command.stdout, command.stderr].filter(Boolean).join(command.stdout && command.stderr ? "\n" : "");
  const longOutput = output.length > 3_000 || output.split("\n").length > 18;
  return (
    <section className="command-log">
      <header>
        <div className="command-line"><span className="prompt-symbol">$</span><code>{command.command}</code></div>
        <div className="command-meta">
          {command.cwd ? <span>{command.cwd}</span> : null}
          {running ? <span className="running-label"><span className="mini-spinner" />运行中</span> : command.exitCode !== undefined ? <span>退出码 {command.exitCode}</span> : null}
          <CopyButton label="复制命令" value={command.command} />
        </div>
      </header>
      {output ? (
        <div className="terminal-output-wrap">
          <pre className={`terminal-output${expanded ? " is-expanded" : ""}`}><code>{command.stdout}{command.stdout && command.stderr && !command.stdout.endsWith("\n") ? "\n" : null}{command.stderr ? <span className="stderr-output">{command.stderr}</span> : null}</code></pre>
          <CopyButton label="复制输出" value={output} />
          {longOutput ? <button className="expand-output" onClick={() => setExpanded(!expanded)} type="button">{expanded ? "收起输出" : "展开全部输出"}</button> : null}
        </div>
      ) : <div className="empty-output">{running ? "等待输出…" : "命令没有输出"}</div>}
    </section>
  );
}

interface DiffInfo {
  files: Array<{ path: string; status: "added" | "deleted" | "modified" | "renamed" }>;
  additions: number;
  deletions: number;
}

function DiffView({ diff, info, onOpenFile }: { diff: string; info: DiffInfo; onOpenFile(path: string): void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const lines = numberedDiffLines(diff);
  const visibleLines = showAll ? lines : lines.slice(0, 260);
  return (
    <section className="diff-view">
      <header className="diff-summary">
        <span>修改了 {info.files.length} 个文件</span>
        <span className="diff-add">+{info.additions}</span>
        <span className="diff-delete">-{info.deletions}</span>
        <CopyButton label="复制 Diff" value={diff} />
      </header>
      {info.files.length ? (
        <div className="diff-files">
          {info.files.map((file) => (
            <button key={`${file.status}-${file.path}`} onClick={() => onOpenFile(file.path)} type="button"><span className={`diff-file-status is-${file.status}`}>{diffStatusLabel(file.status)}</span><span>{file.path}</span></button>
          ))}
        </div>
      ) : null}
      <pre className="diff-code"><code>{visibleLines.map((line, index) => <DiffLine key={`${String(index)}-${line.text.slice(0, 20)}`} line={line} />)}</code></pre>
      {lines.length > visibleLines.length ? <button className="expand-output" onClick={() => setShowAll(true)} type="button">展开全部 {lines.length} 行</button> : null}
    </section>
  );
}

interface NumberedDiffLine {
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

function DiffLine({ line }: { line: NumberedDiffLine }): React.JSX.Element {
  const className = line.text.startsWith("+") && !line.text.startsWith("+++")
    ? "is-addition"
    : line.text.startsWith("-") && !line.text.startsWith("---")
      ? "is-deletion"
      : line.text.startsWith("@@")
        ? "is-hunk"
        : line.text.startsWith("diff ") || line.text.startsWith("index ") || line.text.startsWith("---") || line.text.startsWith("+++")
          ? "is-header"
          : "";
  return <span className={className}><span className="diff-line-number">{line.oldNumber ?? ""}</span><span className="diff-line-number">{line.newNumber ?? ""}</span><span className="diff-line-content">{line.text}</span>{"\n"}</span>;
}

function ToolPayload({ tool }: { tool: TimelineTool }): React.JSX.Element {
  const progress = tool.updates.filter((update) => update.text).map((update) => update.text).join("\n");
  const display = tool.display;
  if (display?.kind === "file_io") {
    const resultPreview = fileToolResult(tool.result);
    return (
      <>
        <dl className="tool-fields">
          <div><dt>操作</dt><dd>{display.operation}</dd></div>
          {display.path ? <div><dt>路径</dt><dd><code>{display.path}</code></dd></div> : null}
          {display.detail ? <div><dt>说明</dt><dd>{display.detail}</dd></div> : null}
          {resultPreview?.count !== undefined ? <div><dt>结果</dt><dd>{resultPreview.count}</dd></div> : null}
        </dl>
        {resultPreview?.text ? <pre className="tool-payload"><code>{resultPreview.text}</code></pre> : null}
      </>
    );
  }
  const value = friendlyResult(tool.result) ?? (progress || friendlyResult(tool.args));
  return value ? <pre className="tool-payload"><code>{value}</code></pre> : <div className="empty-output">没有可展示的详细信息</div>;
}

function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className="copy-button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        });
      }}
      title={label}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

function ToolStatus({ status }: { status: TimelineTool["status"] }): React.JSX.Element {
  if (status === "running") return <span className="tool-state"><span className="mini-spinner" />运行中</span>;
  if (status === "success") return <span className="tool-state"><Icon name="check" size={12} />成功</span>;
  if (status === "failed") return <span className="tool-state is-error"><Icon name="warning" size={12} />失败</span>;
  if (status === "denied") return <span className="tool-state is-error">已拒绝</span>;
  if (status === "aborted") return <span className="tool-state">已中止</span>;
  return <span className="tool-state">等待</span>;
}

function toolSummary(tool: TimelineTool, command: TimelineCommand | undefined, diff: DiffInfo | undefined): string {
  if (command?.command) return command.command;
  if (diff) return `${String(diff.files.length)} 个文件，+${String(diff.additions)} -${String(diff.deletions)}`;
  if (tool.path) return tool.path;
  if (tool.display?.kind === "file_io") return tool.display.path ?? tool.display.detail ?? tool.display.operation;
  if (tool.display?.kind === "generic") return tool.display.summary;
  if (tool.description) return tool.description;
  const args = tool.args as Record<string, unknown> | undefined;
  const candidate = args && [args.path, args.query, args.pattern, args.command].find((value) => typeof value === "string");
  return typeof candidate === "string" ? candidate : "查看详情";
}

function commandDetails(tool: TimelineTool): TimelineCommand | undefined {
  if (tool.command) return tool.command;
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args as Record<string, unknown> : undefined;
  const inferredCommand = tool.tool === "run_command" ? stringField(args, "command") : undefined;
  if (tool.display?.kind !== "command" && !inferredCommand) return undefined;
  const result = typeof tool.result === "object" && tool.result !== null ? tool.result as Record<string, unknown> : undefined;
  return {
    command: tool.display?.kind === "command" ? tool.display.command : inferredCommand ?? "",
    cwd: tool.display?.kind === "command" ? tool.display.cwd : stringField(args, "cwd"),
    stdout: stringField(result, "stdout") ?? stringField(result, "output") ?? "",
    stderr: stringField(result, "stderr") ?? "",
    exitCode: numberField(result, "exitCode")
  };
}

function analyzeDiff(diff: string): DiffInfo {
  const files: DiffInfo["files"] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match?.[2]) continue;
    const renamed = match[1] !== match[2];
    files.push({ path: match[2], status: renamed ? "renamed" : "modified" });
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const blockStart = diff.indexOf(`diff --git a/${file.path}`);
    const nextStart = diff.indexOf("diff --git ", blockStart + 1);
    const block = diff.slice(blockStart, nextStart < 0 ? undefined : nextStart);
    if (block.includes("new file mode")) file.status = "added";
    if (block.includes("deleted file mode")) file.status = "deleted";
  }
  return { files, additions, deletions };
}

function numberedDiffLines(diff: string): NumberedDiffLine[] {
  let oldNumber: number | undefined;
  let newNumber: number | undefined;
  return diff.split("\n").map((text) => {
    if (text.startsWith("diff --git ") || text.startsWith("index ") || text.startsWith("--- ") || text.startsWith("+++ ")) {
      if (text.startsWith("diff --git ")) {
        oldNumber = undefined;
        newNumber = undefined;
      }
      return { text };
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk?.[1] && hunk[2]) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      return { text };
    }
    if (oldNumber === undefined || newNumber === undefined || text.startsWith("\\ No newline")) return { text };
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const line = { text, oldNumber: undefined, newNumber };
      newNumber += 1;
      return line;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const line = { text, oldNumber, newNumber: undefined };
      oldNumber += 1;
      return line;
    }
    const line = { text, oldNumber, newNumber };
    oldNumber += 1;
    newNumber += 1;
    return line;
  });
}

function fileToolResult(value: unknown): { count?: string; text?: string } | undefined {
  if (typeof value !== "object" || value === null) return typeof value === "string" ? { text: value } : undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.matches)) {
    const matches = record.matches;
    const text = matches.slice(0, 200).map((match) => {
      if (typeof match !== "object" || match === null) return String(match);
      const item = match as Record<string, unknown>;
      return [item.path, item.line].filter((part) => typeof part === "string" || typeof part === "number").join(":") + (typeof item.text === "string" ? `  ${item.text}` : "");
    }).join("\n");
    return { count: `${String(matches.length)} 个命中`, text };
  }
  if (Array.isArray(record.files)) {
    return { count: `${String(record.files.length)} 个文件`, text: record.files.slice(0, 300).map(String).join("\n") };
  }
  for (const key of ["content", "output", "message", "summary"]) {
    if (typeof record[key] === "string") return { text: record[key] };
  }
  return undefined;
}

function friendlyResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["output", "content", "message", "summary", "results"]) {
    const field = record[key];
    if (typeof field === "string") return field;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法展示工具结果";
  }
}

function toolIcon(tool: TimelineTool): IconName {
  if (tool.command || tool.display?.kind === "command" || tool.tool === "run_command") return "terminal";
  if (tool.diff || tool.tool === "git_diff") return "diff";
  if (tool.tool.includes("search") || tool.tool.includes("grep")) return "search";
  if (tool.tool.includes("file") || tool.display?.kind === "file_io") return "file";
  return "code";
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "修改文件",
    list_files: "列出文件",
    search_files: "搜索文件",
    grep_search: "搜索内容",
    run_command: "运行命令",
    git_diff: "查看 Diff",
    git_status: "检查 Git"
  };
  return labels[tool] ?? tool.replaceAll("_", " ");
}

function riskLabel(risk: string): string {
  if (risk === "critical") return "关键风险";
  if (risk === "high") return "高风险";
  if (risk === "medium") return "中风险";
  if (risk === "low") return "低风险";
  return "需确认";
}

function diffStatusLabel(status: DiffInfo["files"][number]["status"]): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${String(durationMs)}ms` : `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}
