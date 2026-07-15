import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PermissionResult } from "../../../../permission/PermissionManager.js";
import type { DesktopProject } from "../../../protocol.js";
import type { TimelineTurn } from "../sessionTimeline.js";
import { AppIcon } from "./AppIcon.js";
import { Icon } from "./Icon.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { NavigationControls } from "./NavigationControls.js";

interface WorkspaceProps {
  project?: DesktopProject;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  turns: TimelineTurn[];
  loading: boolean;
  runtimeError?: string;
  unavailableFeature?: string;
  sidebarVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onToggleSidebar(): void;
  onNavigateBack(): void;
  onNavigateForward(): void;
  onOpenProject(): void;
  onRefreshProject(): void;
  onOpenSettings(): void;
  onOpenFile(path: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
  onRetry(input: string): void;
  children?: React.ReactNode;
}

const scrollPositions = new Map<string, number>();

export function Workspace({
  project,
  projectId,
  sessionId,
  sessionTitle,
  turns,
  loading,
  runtimeError,
  unavailableFeature,
  sidebarVisible,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onNavigateBack,
  onNavigateForward,
  onOpenProject,
  onRefreshProject,
  onOpenSettings,
  onOpenFile,
  onResolvePermission,
  onRetry,
  children
}: WorkspaceProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const contentKey = useMemo(() => turns.map((turn) => `${turn.id}:${String(turn.assistant.length)}:${String(turn.tools.length)}:${turn.status}`).join("|"), [turns]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || unavailableFeature) return;
    const key = sessionId ?? `empty:${projectId ?? "none"}`;
    const saved = scrollPositions.get(key);
    container.scrollTop = saved ?? container.scrollHeight;
    followingRef.current = saved === undefined || container.scrollHeight - container.clientHeight - saved < 80;
    setShowJump(!followingRef.current);
    return () => {
      scrollPositions.set(key, container.scrollTop);
    };
  }, [projectId, sessionId, unavailableFeature]);

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

  return (
    <main className="workspace">
      <header className="workspace-toolbar">
        <div className="toolbar-left">
          {!sidebarVisible ? <NavigationControls canGoBack={canGoBack} canGoForward={canGoForward} onBack={onNavigateBack} onForward={onNavigateForward} onToggleSidebar={onToggleSidebar} sidebarVisible={sidebarVisible} /> : null}
          <div className="workspace-title"><span>{sessionTitle ?? project?.name ?? "Biny"}</span>{project?.missing ? <small>路径不可用</small> : null}</div>
        </div>
        <div className="toolbar-actions">
          {project ? <button aria-label="刷新项目状态" className="icon-button" onClick={onRefreshProject} type="button"><Icon name="branch" /></button> : null}
          <button aria-label="工作区菜单" className="icon-button" onClick={onOpenSettings} type="button"><Icon name="more" /></button>
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
        {unavailableFeature ? <UnavailableFeature feature={unavailableFeature} /> : loading ? <LoadingState /> : runtimeError ? <RuntimeError error={runtimeError} /> : turns.length && projectId ? (
          <MessageTimeline
            onOpenFile={onOpenFile}
            onResolvePermission={onResolvePermission}
            onRetry={onRetry}
            projectId={projectId}
            turns={turns}
          />
        ) : <EmptyState onOpenProject={onOpenProject} project={project} />}
        {!unavailableFeature ? <div className="composer-spacer" /> : null}
      </div>
      {showJump && !unavailableFeature ? <button className="jump-bottom" onClick={jumpToBottom} type="button"><Icon name="arrow-up" size={13} /><span>回到底部</span></button> : null}
      {!unavailableFeature ? children : null}
    </main>
  );
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
  return <div className="runtime-error-state"><Icon name="warning" size={22} /><h2>Agent Runtime 无法启动</h2><p>{error}</p><small>桌面端使用与 CLI、TUI 相同的 Provider 配置，请先修复共享配置后重试。</small></div>;
}

function UnavailableFeature({ feature }: { feature: string }): React.JSX.Element {
  return <div className="unavailable-state"><Icon name="spark" size={24} /><h1>{feature}</h1><p>此入口暂未实现。Biny 不会用模拟数据伪装可用结果。</p></div>;
}
