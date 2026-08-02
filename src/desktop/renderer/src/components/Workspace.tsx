/**
 * 主工作区：左侧对话时间线 + 右侧文件面板，中间是可拖动的分隔条。
 *
 * 面板宽度经 `clampFilePanelWidth` 收敛，和主进程用同一套上下限，保证拖动结果与重启后一致。
 * 文件预览的高亮和类型角标都复用渲染层的公共模块。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type {
  DesktopProject,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceFilePreview
} from "../../../protocol.js";
import { clampFilePanelWidth, MAX_FILE_PANEL_WIDTH, MIN_FILE_PANEL_WIDTH } from "../../../filePanelSizing.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { highlightWorkspaceFile } from "../syntaxHighlight.js";
import { workspaceFileMarker } from "../workspaceFileMarker.js";
import { AppIcon } from "./AppIcon.js";
import { CopyButton } from "./CopyButton.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { TerminalView } from "./TerminalView.js";

interface WorkspaceProps {
  filePanelResizing: boolean;
  filePanelWidth: number;
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  onOpenProject(): void;
  onFilePanelResizeEnd(width: number): void;
  onFilePanelResizeStart(): void;
  onFilePanelWidthChange(width: number): void;
  onRefreshProject(): void;
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
  onOpenFile(path: string): void;
  onOpenExternal(url: string): void;
  onPanelNotice(message: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  children?: React.ReactNode;
}

const scrollPositions = new Map<string, number>();

interface FilePreviewState {
  source: string;
  path: string;
  status: "loading" | "ready" | "error";
  file?: DesktopWorkspaceFilePreview;
  error?: string;
}

type FilePanelView = "menu" | "files";

interface FileDirectoryState {
  status: "loading" | "ready" | "error";
  entries?: DesktopWorkspaceDirectoryEntry[];
  error?: string;
}

export function Workspace({
  filePanelResizing,
  filePanelWidth,
  project,
  projectId,
  sessionId,
  sessionTitle,
  turns,
  loading,
  runtimeError,
  onOpenProject,
  onFilePanelResizeEnd,
  onFilePanelResizeStart,
  onFilePanelWidthChange,
  onRefreshProject,
  onListDirectory,
  onReadFile,
  onOpenFile,
  onOpenExternal,
  onPanelNotice,
  onResolvePermission,
  onRetry,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  children
}: WorkspaceProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previewRequestRef = useRef(0);
  const directoryRequestIdRef = useRef(0);
  const directoryRequestRef = useRef(new Map<string, number>());
  const [showJump, setShowJump] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelView, setFilePanelView] = useState<FilePanelView>("menu");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(240);
  const [preview, setPreview] = useState<FilePreviewState>();
  const [directoryStates, setDirectoryStates] = useState<Map<string, FileDirectoryState>>(new Map());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const contentKey = useMemo(() => turns.map((turn) => `${turn.id}:${String(turn.assistant.length)}:${String(turn.steps.length)}:${turn.steps.map((step) => step.kind === "tool" ? `${step.id}:${step.tool.status}:${String(step.tool.updates.length)}` : `${step.id}:${String(step.content.length)}`).join(",")}:${turn.status}`).join("|"), [turns]);
  const previewSource = `${projectId ?? "none"}:${sessionId ?? "draft"}`;
  const activePreview = preview?.source === previewSource ? preview : undefined;

  useLayoutEffect(() => {
    previewRequestRef.current += 1;
    directoryRequestIdRef.current += 1;
    directoryRequestRef.current.clear();
    setPreview(undefined);
    setFilePanelView("menu");
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
  }, [previewSource]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const key = sessionId ?? `empty:${projectId ?? "none"}`;
    const saved = scrollPositions.get(key);
    container.scrollTop = saved ?? container.scrollHeight;
    followingRef.current = saved === undefined || container.scrollHeight - container.clientHeight - saved < 80;
    setShowJump(!followingRef.current);
    return () => {
      scrollPositions.set(key, container.scrollTop);
    };
  }, [projectId, sessionId]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !followingRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [contentKey]);

  const jumpToBottom = (): void => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    followingRef.current = true;
    setShowJump(false);
  };

  const loadDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const requestId = directoryRequestIdRef.current + 1;
    directoryRequestIdRef.current = requestId;
    directoryRequestRef.current.set(normalizedPath, requestId);
    setDirectoryStates((current) => {
      const next = new Map(current);
      next.set(normalizedPath, { status: "loading" });
      return next;
    });
    void onListDirectory(normalizedPath).then((directory) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizeWorkspacePath(directory.path), { status: "ready", entries: directory.entries });
        return next;
      });
    }).catch((error: unknown) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizedPath, { status: "error", error: errorMessage(error) });
        return next;
      });
    });
  }, [onListDirectory]);

  const openPanelMenu = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
    setFilePanelView("menu");
    setFilePanelOpen(true);
  }, []);

  const toggleTerminalDock = useCallback((): void => {
    if (!projectId) {
      onPanelNotice("请先打开一个项目");
      return;
    }
    setTerminalOpen((open) => !open);
  }, [onPanelNotice, projectId]);

  const openFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    directoryRequestRef.current.clear();
    setPreview(undefined);
    setFilePanelView("files");
    setFilePanelOpen(true);
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
    loadDirectory(".");
  }, [loadDirectory]);

  const previewFile = useCallback((path: string): void => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setFilePanelOpen(true);
    setFilePanelView("files");
    setPreview({ source: previewSource, path, status: "loading", file: undefined, error: undefined });
    void onReadFile(path).then((file) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source: previewSource, path: file.path, status: "ready", file, error: undefined });
    }).catch((error: unknown) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source: previewSource, path, status: "error", file: undefined, error: errorMessage(error) });
    });
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, onReadFile, previewSource]);

  const showFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
    setFilePanelView("files");
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory]);

  const toggleDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const willExpand = !expandedDirectories.has(normalizedPath);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (willExpand) next.add(normalizedPath);
      else next.delete(normalizedPath);
      return next;
    });
    const state = directoryStates.get(normalizedPath);
    if (willExpand && (!state || state.status === "error")) loadDirectory(normalizedPath);
  }, [directoryStates, expandedDirectories, loadDirectory]);

  return (
    <main
      className={`workspace${filePanelOpen ? " is-file-panel-open" : ""}${filePanelResizing ? " is-file-panel-resizing" : ""}`}
      style={{
        "--workspace-file-panel-width": filePanelOpen ? `${filePanelWidth}px` : "0px",
        "--terminal-dock-height": terminalOpen && projectId ? `${String(terminalHeight)}px` : "0px"
      } as React.CSSProperties}
    >
      <section className="workspace-conversation">
        <header className="workspace-toolbar">
          <div className="toolbar-left">
            <div className="workspace-title"><span>{sessionTitle ?? project?.name ?? "Biny"}</span>{project?.missing ? <small>路径不可用</small> : null}</div>
          </div>
          <div className="toolbar-actions">
            {project ? <button aria-label="刷新项目状态" className="icon-button" onClick={onRefreshProject} type="button"><Icon name="branch" /></button> : null}
            <button
              aria-label={terminalOpen ? "关闭终端" : "打开终端"}
              aria-pressed={terminalOpen}
              className={`icon-button terminal-toggle${terminalOpen ? " is-active" : ""}`}
              onClick={toggleTerminalDock}
              title={terminalOpen ? "关闭终端" : "打开终端"}
              type="button"
            >
              <Icon name="terminal" />
            </button>
            <button
              aria-label={filePanelOpen ? "关闭右侧文件面板" : "打开右侧文件面板"}
              aria-pressed={filePanelOpen}
              className={`icon-button file-panel-toggle${filePanelOpen ? " is-active" : ""}`}
              onClick={() => { if (filePanelOpen) setFilePanelOpen(false); else openPanelMenu(); }}
              title={filePanelOpen ? "关闭工具面板" : "打开工具面板"}
              type="button"
            >
              <Icon name="panel-right" />
            </button>
          </div>
        </header>

        <div
          className="workspace-scroll"
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
            followingRef.current = atBottom;
            setShowJump(!atBottom);
            const key = sessionId ?? `empty:${projectId ?? "none"}`;
            scrollPositions.set(key, element.scrollTop);
          }}
          ref={scrollRef}
        >
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} /> : turns.length && projectId ? (
            <MessageTimeline
              onCreateBranch={onCreateBranch}
              onDeleteUserMessage={onDeleteUserMessage}
              onEditUserMessage={onEditUserMessage}
              onPreviewFile={previewFile}
              onOpenExternal={onOpenExternal}
              onResolvePermission={onResolvePermission}
              onRollbackFiles={onRollbackFiles}
              onRetry={onRetry}
              projectId={projectId}
              sessionId={sessionId}
              turns={turns}
            />
          ) : <EmptyState onOpenProject={onOpenProject} project={project} />}
          <div className="composer-spacer" />
        </div>
        <div className="composer-dock">
          {showJump ? <button className="jump-bottom" onClick={jumpToBottom} type="button"><Icon name="arrow-up" size={13} /><span>回到底部</span></button> : null}
          {children}
        </div>
        {terminalOpen && projectId ? (
          <section aria-label="内嵌终端" className="terminal-dock">
            <TerminalDockResizer height={terminalHeight} onHeightChange={setTerminalHeight} />
            <header className="terminal-dock-header">
              <span className="terminal-dock-title"><Icon name="terminal" size={13} />终端</span>
              <button aria-label="关闭终端" className="icon-button" onClick={() => setTerminalOpen(false)} title="关闭终端" type="button"><Icon name="close" size={14} /></button>
            </header>
            <TerminalView projectId={projectId} />
          </section>
        ) : null}
      </section>
      <div
        aria-hidden={!filePanelOpen}
        className={`workspace-file-region${filePanelOpen ? " is-open" : ""}${filePanelResizing ? " is-resizing" : ""}`}
        inert={!filePanelOpen}
        style={{ width: filePanelOpen ? filePanelWidth : 0 }}
      >
        <FilePanelResizer
          onResizeEnd={onFilePanelResizeEnd}
          onResizeStart={onFilePanelResizeStart}
          onWidthChange={onFilePanelWidthChange}
          width={filePanelWidth}
        />
        <FilePreviewPanel
          directoryStates={directoryStates}
          expandedDirectories={expandedDirectories}
          onOpenFiles={openFileBrowser}
          onOpenFile={onOpenFile}
          onOpenTerminal={() => {
            setFilePanelOpen(false);
            if (!terminalOpen) toggleTerminalDock();
          }}
          onPanelNotice={onPanelNotice}
          onPreviewFile={previewFile}
          onShowFiles={showFileBrowser}
          onToggleDirectory={toggleDirectory}
          open={filePanelOpen}
          preview={activePreview}
          view={filePanelView}
        />
      </div>
    </main>
  );
}

const minTerminalDockHeight = 120;

function TerminalDockResizer({ height, onHeightChange }: { height: number; onHeightChange(height: number): void }): React.JSX.Element {
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const conversation = event.currentTarget.closest(".workspace-conversation");
    // 至少给消息区和输入框留出空间，终端最多占对话列高度减去这段余量。
    const maxHeight = Math.max(minTerminalDockHeight, (conversation instanceof HTMLElement ? conversation.clientHeight : window.innerHeight) - 220);
    const startY = event.clientY;
    const startHeight = height;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      onHeightChange(Math.min(Math.max(startHeight + startY - moveEvent.clientY, minTerminalDockHeight), maxHeight));
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      aria-label="调整终端高度"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      className="terminal-dock-resizer"
      onPointerDown={startResize}
      role="separator"
    />
  );
}

function FilePanelResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: {
  width: number;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(width: number): void;
}): React.JSX.Element {
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    onResizeStart();
    const workspace = event.currentTarget.closest(".workspace");
    const workspaceWidth = workspace instanceof HTMLElement ? workspace.clientWidth : window.innerWidth;
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    let currentWidth = startWidth;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      currentWidth = clampFilePanelWidth(startWidth + startX - moveEvent.clientX, workspaceWidth, false);
      onWidthChange(currentWidth);
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      onResizeEnd(currentWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      aria-label="调整右侧面板宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_FILE_PANEL_WIDTH}
      aria-valuemin={MIN_FILE_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      className="file-panel-resizer"
      onPointerDown={startResize}
      role="separator"
    />
  );
}

function FilePreviewPanel({
  preview,
  view,
  directoryStates,
  expandedDirectories,
  open,
  onOpenFiles,
  onOpenFile,
  onOpenTerminal,
  onPanelNotice,
  onPreviewFile,
  onShowFiles,
  onToggleDirectory
}: {
  preview?: FilePreviewState;
  view: FilePanelView;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  open: boolean;
  onOpenFiles(): void;
  onOpenFile(path: string): void;
  onOpenTerminal(): void;
  onPanelNotice(message: string): void;
  onPreviewFile(path: string): void;
  onShowFiles(): void;
  onToggleDirectory(path: string): void;
}): React.JSX.Element {
  const file = preview?.file;
  const path = file?.path ?? preview?.path;
  const [query, setQuery] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  if (view === "menu") {
    return (
      <aside aria-label="工作区工具" className="file-preview-panel file-panel-menu-panel t-panel-slide" data-open={String(open)}>
        <FilePanelMenu
          onOpenFiles={() => {
            setQuery("");
            setFileTreeOpen(true);
            onOpenFiles();
          }}
          onOpenTerminal={onOpenTerminal}
          onPanelNotice={onPanelNotice}
        />
      </aside>
    );
  }
  return (
    <aside aria-label={preview ? "文件预览" : "文件浏览器"} className="file-preview-panel file-browser-panel t-panel-slide" data-open={String(open)}>
      <header className="file-browser-path">
        <span className="file-browser-current-path">{path ? `/${path}` : "/"}</span>
        <div className="file-browser-path-actions">
          {preview?.status === "ready" && path ? <button aria-label="使用系统应用打开" className="icon-button" onClick={() => onOpenFile(path)} title="使用系统应用打开" type="button"><Icon name="external" size={15} /></button> : null}
          {preview ? <button aria-label="关闭当前文件" className="icon-button" onClick={onShowFiles} title="关闭当前文件" type="button"><Icon name="close" size={15} /></button> : null}
          <button
            aria-label={fileTreeOpen ? "隐藏文件区" : "显示文件区"}
            aria-pressed={fileTreeOpen}
            className={`icon-button file-tree-toggle${fileTreeOpen ? " is-active" : ""}`}
            onClick={() => setFileTreeOpen((current) => !current)}
            title={fileTreeOpen ? "隐藏文件区" : "显示文件区"}
            type="button"
          >
            <Icon name="folder-panel" size={16} />
          </button>
        </div>
      </header>
      <div className={`file-browser-body${fileTreeOpen ? "" : " is-tree-hidden"}`}>
        <div className="file-browser-content">
          {preview ? <FilePreviewContent preview={preview} /> : <FileBrowserEmpty />}
        </div>
        <div aria-hidden={!fileTreeOpen} className="file-browser-tree t-resize" inert={!fileTreeOpen}>
          <label className="file-browser-search"><Icon name="search" size={14} /><input aria-label="筛选文件" onChange={(event) => setQuery(event.target.value)} placeholder="筛选文件..." value={query} /></label>
          <FileTree
            directoryStates={directoryStates}
            expandedDirectories={expandedDirectories}
            onPreviewFile={onPreviewFile}
            onToggleDirectory={onToggleDirectory}
            path="."
            query={query}
          />
        </div>
      </div>
    </aside>
  );
}

function FilePanelMenu({ onOpenFiles, onOpenTerminal, onPanelNotice }: { onOpenFiles(): void; onOpenTerminal(): void; onPanelNotice(message: string): void }): React.JSX.Element {
  const items = [
    { icon: "diff" as const, label: "审阅", shortcut: "⌃⇧G", onClick: () => onPanelNotice("审阅入口暂未实现") },
    { icon: "terminal" as const, label: "终端", shortcut: undefined, onClick: onOpenTerminal },
    { icon: "site" as const, label: "浏览器", shortcut: "⌘T", onClick: () => onPanelNotice("浏览器入口暂未实现") },
    { icon: "folder" as const, label: "文件", shortcut: "⌘P", onClick: onOpenFiles }
  ];
  return (
    <div className="file-panel-menu">
      {items.map((item) => (
        <button key={item.label} className={`file-panel-menu-item${item.label === "文件" ? " file-panel-menu-item--files" : ""}`} onClick={item.onClick} type="button">
          <span className="file-panel-menu-icon"><Icon name={item.icon} size={15} /></span>
          <span>{item.label}</span>
          {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
        </button>
      ))}
    </div>
  );
}

function FileBrowserEmpty(): React.JSX.Element {
  return (
    <div className="file-browser-empty">
      <Icon name="folder-panel" size={42} />
      <strong>打开文件</strong>
      <span>从工作区目录中选择文件</span>
    </div>
  );
}

function FilePreviewContent({ preview }: { preview: FilePreviewState }): React.JSX.Element {
  const file = preview.file;
  if (preview.status === "loading") return <div className="file-preview-state"><span className="large-spinner" /><span>正在读取文件</span></div>;
  if (preview.status === "error") return <div className="file-preview-state is-error"><Icon name="warning" size={18} /><span>{preview.error}</span></div>;
  if (file?.binary) return <div className="file-preview-state"><Icon name="file" size={18} /><span>这是二进制文件，请使用系统应用打开。</span></div>;
  if (!file) return <div className="file-preview-state"><span>无法读取文件</span></div>;
  if (!file.content) return <div className="file-preview-state"><span>空文件</span></div>;
  const highlighted = highlightWorkspaceFile(file.path, file.content);
  return (
    <>
      <div className="file-preview-meta">
        <span>{highlighted.language ?? "纯文本"}</span>
        <div className="file-preview-meta-actions">
          <span>{formatBytes(file.bytes)}{file.truncated ? " · 仅显示前 512 KB" : ""}</span>
          <CopyButton className="copy-button" label="复制文件内容" value={file.content} />
        </div>
      </div>
      <pre className="file-preview-code"><code className={highlighted.language ? `hljs language-${highlighted.language}` : "hljs"} dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
    </>
  );
}

function FileTree({ path, query, directoryStates, expandedDirectories, onToggleDirectory, onPreviewFile, depth = 0 }: {
  path: string;
  query: string;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onToggleDirectory(path: string): void;
  onPreviewFile(path: string): void;
  depth?: number;
}): React.JSX.Element {
  const state = directoryStates.get(path);
  if (!state || state.status === "loading") return <div className="file-tree-state"><span className="mini-spinner" /><span>正在读取目录</span></div>;
  if (state.status === "error") return <div className="file-tree-state is-error"><Icon name="warning" size={14} /><span>{state.error}</span></div>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (state.entries ?? []).filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery));
  if (!entries.length) return <div className="file-tree-state">{normalizedQuery ? "没有匹配文件" : "目录为空"}</div>;
  return (
    <div className="file-tree-level">
      {entries.map((entry) => {
        const isExpanded = expandedDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button className="file-tree-row" onClick={() => entry.kind === "directory" ? onToggleDirectory(entry.path) : onPreviewFile(entry.path)} style={{ paddingLeft: `${8 + depth * 14}px` }} title={entry.path} type="button">
              {entry.kind === "directory" ? <span className={`file-tree-disclosure${isExpanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span> : <FileTreeMarker name={entry.name} />}
              <span>{entry.name}</span>
            </button>
            {entry.kind === "directory" && isExpanded ? <FileTree directoryStates={directoryStates} depth={depth + 1} expandedDirectories={expandedDirectories} onPreviewFile={onPreviewFile} onToggleDirectory={onToggleDirectory} path={entry.path} query={query} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function FileTreeMarker({ name }: { name: string }): React.JSX.Element {
  const marker = workspaceFileMarker(name);
  return <span aria-hidden="true" className={`file-type-marker is-${marker.tone}${marker.label.length > 2 ? " is-wide" : ""}`}>{marker.label}</span>;
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EmptyState({ project, onOpenProject }: { project?: DesktopProject; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="empty-workspace">
      <AppIcon className="empty-app-icon" size={48} />
      {project ? <h1>我们应该在 <button onClick={onOpenProject} type="button">{project.name}</button> 中构建什么？</h1> : <><h1>打开一个本地项目开始使用 Biny</h1><button className="empty-primary" onClick={onOpenProject} type="button"><Icon name="folder" />打开项目</button></>}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="loading-workspace"><span className="large-spinner" /><span>正在恢复会话</span></div>;
}

function RuntimeError({ error }: { error: string }): React.JSX.Element {
  return <div className="runtime-error-state"><Icon name="warning" size={22} /><h2>Agent Runtime 无法启动</h2><p>{error}</p><small>如果提示另一个 Biny/CLI 会话占用，请先退出该会话或切换项目；其他错误请检查共享配置后重试。</small></div>;
}
