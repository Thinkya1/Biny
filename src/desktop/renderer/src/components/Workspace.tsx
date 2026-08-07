/**
 * Desktop 主工作区。
 *
 * 新建页使用紧凑的单框布局；已有会话继续沿用 Biny 的时间线、
 * 权限和文件检查器回调。页面层只负责把这些能力放到正确的视觉区域。
 */
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { UsageSummary } from "../../../../session/metadata.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { DesktopProject, DesktopRuntimeMutation, DesktopRuntimeProjection } from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { formatUsageCost } from "../usagePresentation.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { UsageSummaryPopover } from "./UsageSummaryPopover.js";

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  runtimeProjection?: DesktopRuntimeProjection;
  sessionUsage: UsageSummary;
  onOpenProject(): void;
  onPreviewFile(path: string): void;
  onToggleFiles(): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onResume(): Promise<void>;
  onRetry(input: string): void;
  onEditUserMessage(input: string, userMessageIndex: number): Promise<void>;
  onCreateBranch(): void;
  onRollbackFiles(turn: TimelineTurn): void;
  onDeleteUserMessage(turnId: string): void;
  onRuntimeError(error: unknown): void;
  onRuntimeMutation(operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void>;
  onRuntimeRefresh(): Promise<void>;
  children?: React.ReactNode;
}

export function Workspace({
  project,
  projectId,
  sessionId,
  sessionTitle,
  turns,
  loading,
  runtimeError,
  runtimeProjection,
  sessionUsage,
  onOpenProject,
  onPreviewFile,
  onToggleFiles,
  onOpenExternal,
  onResolvePermission,
  onResume,
  onRetry,
  onEditUserMessage,
  onCreateBranch,
  onRollbackFiles,
  onDeleteUserMessage,
  onRuntimeError,
  onRuntimeMutation,
  onRuntimeRefresh,
  children
}: WorkspaceProps): React.JSX.Element {
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageControlRef = useRef<HTMLDivElement>(null);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
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
            <div className="cindy-usage-control" ref={usageControlRef}>
              <button
                aria-expanded={usageOpen}
                aria-label="查看本会话费用"
                className={`cindy-toolbar-button cindy-usage-toolbar-button${usageOpen ? " is-open" : ""}`}
                onClick={() => setUsageOpen((current) => !current)}
                title="本会话费用"
                type="button"
              >
                <Icon name="chart" size={14} />
                <span className="cindy-usage-toolbar-label">{sessionUsage.calls ? formatUsageCost(sessionUsage) : "费用"}</span>
              </button>
              {usageOpen ? <UsageSummaryPopover anchorRef={usageControlRef} onClose={closeUsage} summary={sessionUsage} /> : null}
            </div>
            <button
              aria-expanded={runtimePanelOpen}
              aria-label="打开后台运行面板"
              className="cindy-toolbar-button cindy-runtime-toolbar-button"
              disabled={!projectId}
              onClick={() => setRuntimePanelOpen((current) => !current)}
              title="后台运行"
              type="button"
            >
              <Icon name="activity" size={15} />
            </button>
            <button
              aria-label="打开文件面板"
              className="cindy-toolbar-button"
              disabled={!projectId}
              onClick={onToggleFiles}
              type="button"
            >
              <Icon name="panel-right" size={15} />
            </button>
          </div>
        </header>
        {runtimePanelOpen ? (
          <RuntimePanel
            onError={onRuntimeError}
            onMutation={onRuntimeMutation}
            onRefresh={onRuntimeRefresh}
            projection={runtimeProjection}
          />
        ) : null}
        <div className="cindy-chat-body">
          {loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} onOpenProject={onOpenProject} /> : turns.length > 0 && projectId ? (
            <ChatScroll>
              <MessageTimeline
                onCreateBranch={onCreateBranch}
                onDeleteUserMessage={onDeleteUserMessage}
                onEditUserMessage={onEditUserMessage}
                onOpenExternal={onOpenExternal}
                onPreviewFile={onPreviewFile}
                onResolvePermission={onResolvePermission}
                onResume={onResume}
                onRollbackFiles={onRollbackFiles}
                onRetry={onRetry}
                projectId={projectId}
                sessionId={sessionId}
                turns={turns}
              />
            </ChatScroll>
          ) : (
            <div className="cindy-chat-empty"><Icon name="message" size={20} /><span>开始一段新的对话</span></div>
          )}
        </div>
        <div className="cindy-chat-composer">{children}</div>
      </div>
      {streaming ? <span className="cindy-streaming-state" aria-hidden="true" /> : null}
    </div>
  );
}

function ChatScroll({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [scrollActive, setScrollActive] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
  }, []);

  const revealScrollbar = (): void => {
    setScrollActive(true);
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = undefined;
      setScrollActive(false);
    }, 1000);
  };

  return (
    <div className={`cindy-chat-scroll${scrollActive ? " is-scroll-active" : ""}`} onScroll={revealScrollbar} onWheel={revealScrollbar}>
      {children}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return <div className="cindy-status-state" role="status"><ThinkingOrb aria-label="正在恢复会话" className="thinking-orb" size={20} state="connecting" theme="auto" /><span>正在恢复会话…</span></div>;
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
