/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type {
  DesktopProject,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceFilePreview
} from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { useWorkspaceInspector } from "./workspace/useWorkspaceInspector.js";

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
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
  onOpenFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  children?: React.ReactNode;
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
  onListDirectory,
  onReadFile,
  onOpenFile,
  onOpenExternal,
  onResolvePermission,
  onRetry,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  children
}: WorkspaceProps): React.JSX.Element {
  const inspector = useWorkspaceInspector({
    filePanelResizing,
    filePanelWidth,
    onFilePanelResizeEnd,
    onFilePanelResizeStart,
    onFilePanelWidthChange,
    onListDirectory,
    onOpenFile,
    onReadFile,
    projectId,
    source: `${projectId ?? "none"}:${sessionId ?? "draft"}`
  });
  const streaming = turns.some((turn) => turn.status === "running" || turn.status === "waiting_permission");
  const isHome = !loading && !runtimeError && turns.length === 0;

  if (isHome) {
    return (
      <div className="workspace cindy-workspace cindy-workspace-home">
        <div className="cindy-home-mode" aria-label="当前模式">
          <Icon name="message" size={15} />
          <span>对话</span>
          <Icon name="chevron" size={13} />
        </div>
        <div className="cindy-home-content">
          <div className="cindy-home-composer">{children}</div>
        </div>
        {inspector.dock}
      </div>
    );
  }

  return (
    <div className="workspace cindy-workspace cindy-workspace-chat">
      <div className="cindy-workspace-main">
        <header className="cindy-chat-toolbar">
          <div className="cindy-chat-title">
            <strong>{sessionTitle ?? project?.name ?? "Biny"}</strong>
            {project ? <span>{project.name}{project.branch ? ` · ${project.branch}` : ""}</span> : <span>打开一个本地项目开始</span>}
          </div>
          <div className="cindy-chat-actions">
            <button
              aria-label="打开文件面板"
              className="cindy-toolbar-button"
              disabled={!projectId}
              onClick={inspector.toggleFiles}
              type="button"
            >
              <Icon name="panel-right" size={15} />
            </button>
          </div>
        </header>
        <div className="cindy-chat-body">
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : turns.length > 0 && projectId ? (
            <div className="cindy-chat-scroll">
              <MessageTimeline
                onCreateBranch={onCreateBranch}
                onDeleteUserMessage={onDeleteUserMessage}
                onEditUserMessage={onEditUserMessage}
                onOpenExternal={onOpenExternal}
                onPreviewFile={inspector.previewFile}
                onResolvePermission={onResolvePermission}
                onRollbackFiles={onRollbackFiles}
                onRetry={onRetry}
                projectId={projectId}
                sessionId={sessionId}
                turns={turns}
              />
            </div>
          ) : (
            <div className="cindy-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        <div className="cindy-chat-composer">{children}</div>
      </div>
      {inspector.dock}
      {streaming ? <span className="cindy-streaming-state" aria-hidden="true" /> : null}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="cindy-status-state" role="status"><span className="large-spinner" /><span>正在恢复会话…</span></div>;
}

function RuntimeError({ error, onOpenProject }: { error: string; onOpenProject(): void }): React.JSX.Element {
  return (
    <div className="cindy-runtime-error" role="alert">
      <Icon name="warning" size={22} />
      <h2>Agent Runtime 无法启动</h2>
      <p>{error}</p>
      <small>若另一个 Biny/CLI 会话正在占用项目，请先退出该会话；其他错误请检查共享配置后重试。</small>
      <button onClick={onOpenProject} type="button">打开其他项目</button>
    </div>
  );
}
