/* eslint-disable react-refresh/only-export-components -- Inspector 请求状态与私有视图必须共享同一生命周期。 */
/**
 * Workspace 右侧检查器的状态与视图。
 *
 * 文件树、文件预览、终端切换和面板尺寸都属于 Inspector 自己的交互状态；会话区只拿到
 * 一个 dock 节点与 `previewFile` 命令，不再理解目录请求或终端布局。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { EmptyState as AstryxEmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import type {
  DesktopWorkspaceDirectory,
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceFilePreview
} from "../../../../protocol.js";
import {
  clampFilePanelWidth,
  MAX_FILE_PANEL_WIDTH,
  MIN_FILE_PANEL_WIDTH
} from "../../../../filePanelSizing.js";
import { highlightWorkspaceFile } from "../../syntaxHighlight.js";
import { workspaceFileMarker } from "../../workspaceFileMarker.js";
import { CopyButton } from "../CopyButton.js";
import { Icon } from "../Icon.js";
import { TerminalView } from "../TerminalView.js";

interface UseWorkspaceInspectorOptions {
  filePanelResizing: boolean;
  filePanelWidth: number;
  projectId?: string;
  source: string;
  onFilePanelResizeEnd(width: number): void;
  onFilePanelResizeStart(): void;
  onFilePanelWidthChange(width: number): void;
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onOpenFile(path: string): void;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
}

interface FilePreviewState {
  source: string;
  path: string;
  status: "loading" | "ready" | "error";
  file?: DesktopWorkspaceFilePreview;
  error?: string;
}

interface FileDirectoryState {
  status: "loading" | "ready" | "error";
  entries?: DesktopWorkspaceDirectoryEntry[];
  error?: string;
}

type InspectorView = "files" | "terminal";

export function useWorkspaceInspector({
  filePanelResizing,
  filePanelWidth,
  projectId,
  source,
  onFilePanelResizeEnd,
  onFilePanelResizeStart,
  onFilePanelWidthChange,
  onListDirectory,
  onOpenFile,
  onReadFile
}: UseWorkspaceInspectorOptions): {
  dock?: React.JSX.Element;
  filesOpen: boolean;
  terminalOpen: boolean;
  openFiles(): void;
  previewFile(path: string): void;
  toggleFiles(): void;
  toggleTerminal(): void;
} {
  const previewRequestRef = useRef(0);
  const directoryRequestIdRef = useRef(0);
  const directoryRequestRef = useRef(new Map<string, number>());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const [preview, setPreview] = useState<FilePreviewState>();
  const [directoryStates, setDirectoryStates] = useState<Map<string, FileDirectoryState>>(new Map());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const activePreview = preview?.source === source ? preview : undefined;

  useLayoutEffect(() => {
    previewRequestRef.current += 1;
    directoryRequestIdRef.current += 1;
    directoryRequestRef.current.clear();
    setPreview(undefined);
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
  }, [source]);

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

  const openInspector = useCallback((view: InspectorView): void => {
    if (!projectId) return;
    setInspectorView(view);
    setInspectorOpen(true);
    if (view === "files" && !directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, projectId]);

  const toggleInspectorView = useCallback((view: InspectorView): void => {
    if (inspectorOpen && inspectorView === view) {
      setInspectorOpen(false);
      return;
    }
    openInspector(view);
  }, [inspectorOpen, inspectorView, openInspector]);

  const openFiles = useCallback((): void => {
    openInspector("files");
  }, [openInspector]);

  const toggleFiles = useCallback((): void => {
    toggleInspectorView("files");
  }, [toggleInspectorView]);

  const toggleTerminal = useCallback((): void => {
    toggleInspectorView("terminal");
  }, [toggleInspectorView]);

  const previewFile = useCallback((path: string): void => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setInspectorView("files");
    setInspectorOpen(true);
    setPreview({ source, path, status: "loading", file: undefined, error: undefined });
    void onReadFile(path).then((file) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path: file.path, status: "ready", file, error: undefined });
    }).catch((error: unknown) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path, status: "error", file: undefined, error: errorMessage(error) });
    });
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, onReadFile, source]);

  const showFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
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

  const inspector = inspectorOpen && projectId ? (
    <div className={`desktop-inspector-wrap${filePanelResizing ? " is-resizing" : ""}`} style={{ width: filePanelWidth }}>
      <FilePanelResizer
        onResizeEnd={onFilePanelResizeEnd}
        onResizeStart={onFilePanelResizeStart}
        onWidthChange={onFilePanelWidthChange}
        width={filePanelWidth}
      />
      <LayoutPanel className="desktop-inspector" isScrollable={false} label="工作区检查器" padding={0} role="complementary" width="100%">
        <header className="desktop-inspector-header">
          <TabList hasDivider={false} onChange={(value) => openInspector(value as InspectorView)} size="sm" value={inspectorView}>
            <Tab icon={<Icon name="folder" size={13} />} label="文件" value="files" />
            <Tab icon={<Icon name="terminal" size={13} />} label="终端" value="terminal" />
          </TabList>
        </header>
        <div className="desktop-inspector-body">
          {inspectorView === "terminal" ? <TerminalView projectId={projectId} /> : (
            <FilePreviewPanel
              directoryStates={directoryStates}
              expandedDirectories={expandedDirectories}
              onOpenFile={onOpenFile}
              onPreviewFile={previewFile}
              onShowFiles={showFileBrowser}
              onToggleDirectory={toggleDirectory}
              preview={activePreview}
            />
          )}
        </div>
      </LayoutPanel>
    </div>
  ) : undefined;

  return {
    dock: inspector,
    filesOpen: inspectorOpen && inspectorView === "files",
    terminalOpen: inspectorOpen && inspectorView === "terminal",
    openFiles,
    previewFile,
    toggleFiles,
    toggleTerminal
  };
}

function FilePanelResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: {
  width: number;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(width: number): void;
}): React.JSX.Element {
  const resizeWithKeyboard = (direction: -1 | 1): void => {
    const next = clampFilePanelWidth(width + direction * 16, window.innerWidth, false);
    onWidthChange(next);
    onResizeEnd(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
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
      aria-label="调整检查器宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_FILE_PANEL_WIDTH}
      aria-valuemin={MIN_FILE_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      className="desktop-inspector-resizer"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(1); }
        if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(-1); }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    />
  );
}

function FilePreviewPanel({ preview, directoryStates, expandedDirectories, onOpenFile, onPreviewFile, onShowFiles, onToggleDirectory }: {
  preview?: FilePreviewState;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onOpenFile(path: string): void;
  onPreviewFile(path: string): void;
  onShowFiles(): void;
  onToggleDirectory(path: string): void;
}): React.JSX.Element {
  const file = preview?.file;
  const path = file?.path ?? preview?.path;
  const [query, setQuery] = useState("");
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  return (
    <aside aria-label={preview ? "文件预览" : "文件浏览器"} className="file-preview-panel file-browser-panel">
      <header className="file-browser-path">
        <span className="file-browser-current-path">{path ? `/${path}` : "/"}</span>
        <div className="file-browser-path-actions">
          {preview?.status === "ready" && path ? <IconButton icon={<Icon name="external" size={14} />} label="使用系统应用打开" onClick={() => onOpenFile(path)} size="sm" tooltip="使用系统应用打开" variant="ghost" /> : null}
          {preview ? <IconButton icon={<Icon name="close" size={14} />} label="关闭当前文件" onClick={onShowFiles} size="sm" tooltip="返回文件列表" variant="ghost" /> : null}
          <IconButton
            aria-pressed={fileTreeOpen}
            icon={<Icon name="folder-panel" size={15} />}
            label={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
            onClick={() => setFileTreeOpen((current) => !current)}
            size="sm"
            tooltip={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
            variant={fileTreeOpen ? "secondary" : "ghost"}
          />
        </div>
      </header>
      <div className={`file-browser-body${fileTreeOpen ? "" : " is-tree-hidden"}`}>
        <div className="file-browser-content">
          {preview ? <FilePreviewContent preview={preview} /> : <FileBrowserEmpty />}
        </div>
        <div aria-hidden={!fileTreeOpen} className="file-browser-tree" inert={!fileTreeOpen}>
          <TextInput hasClear isLabelHidden label="筛选文件" onChange={setQuery} placeholder="筛选文件…" size="sm" startIcon={<Icon name="search" size={13} />} value={query} width="100%" />
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

function FileBrowserEmpty(): React.JSX.Element {
  return <AstryxEmptyState description="从右侧文件树选择一个文件进行预览。" icon={<Icon name="folder-panel" size={30} />} isCompact title="选择文件" />;
}

function FilePreviewContent({ preview }: { preview: FilePreviewState }): React.JSX.Element {
  const file = preview.file;
  if (preview.status === "loading") return <div className="file-preview-state"><span className="large-spinner" /><span>正在读取文件…</span></div>;
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
  if (!state || state.status === "loading") return <div className="file-tree-state"><span className="mini-spinner" /><span>正在读取目录…</span></div>;
  if (state.status === "error") return <div className="file-tree-state is-error"><Icon name="warning" size={14} /><span>{state.error}</span></div>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (state.entries ?? []).filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery));
  if (!entries.length) return <div className="file-tree-state">{normalizedQuery ? "没有匹配文件" : "目录为空"}</div>;
  return (
    <div className="file-tree-level">
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expandedDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button className={`file-tree-row${isDirectory ? " is-directory" : ""}`} onClick={() => isDirectory ? onToggleDirectory(entry.path) : onPreviewFile(entry.path)} style={{ paddingLeft: `${8 + depth * 16}px` }} title={entry.path} type="button">
              {isDirectory ? <span className={`file-tree-disclosure${isExpanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span> : <span aria-hidden="true" className="file-tree-disclosure is-file-slot" />}
              {isDirectory ? <Icon className="file-tree-folder-icon" name="folder" size={14} /> : <FileTreeMarker name={entry.name} />}
              <span>{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? <FileTree directoryStates={directoryStates} depth={depth + 1} expandedDirectories={expandedDirectories} onPreviewFile={onPreviewFile} onToggleDirectory={onToggleDirectory} path={entry.path} query={query} /> : null}
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
