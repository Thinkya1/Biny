/**
 * 桌面端主侧栏。
 *
 * 侧栏的数据仍由 App 投影，组件只负责把项目、会话和菜单动作组织成置顶项目、普通项目
 * 和未归类对话三段树。项目与会话的业务操作通过回调返回上层，避免把 IPC 和持久化状态
 * 复制到视觉组件中。
 */
import { createPortal } from "react-dom";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SidebarLayoutSnapshot } from "../../../sidebarLayout.js";
import { MAX_SIDEBAR_WIDTH, SIDEBAR_RAIL_WIDTH } from "../../../sidebarSizing.js";
import type { DesktopProject, DesktopSessionSummary, DesktopSessionTreePage } from "../../../protocol.js";
import type { SidebarPeekHandlers } from "../app/useSidebarLayout.js";
import { Icon, type IconName } from "./Icon.js";

const PROJECT_SESSION_COLLAPSE_LIMIT = 5;
const DIALOGUE_SESSION_COLLAPSE_LIMIT = 10;

type SidebarSectionName = "pinned" | "projects" | "dialogue";
type ProjectSort = "priority" | "recent" | "manual";
type ProjectDragPlacement = "before" | "after";
type FloatingMenuAnchor = { readonly current: HTMLElement | null };
type SidebarNavAction = "newTask" | "extensions" | "settings" | "search";

const SIDEBAR_NAV_ITEMS: ReadonlyArray<{
  action?: SidebarNavAction;
  disabled?: boolean;
  icon: IconName;
  label: string;
  title?: string;
}> = [
  { action: "newTask", icon: "circle-add", label: "新建" },
  { disabled: true, icon: "timer", label: "自动化", title: "自动化功能暂未开放" },
  { action: "extensions", icon: "plug", label: "插件" },
  { action: "search", icon: "search", label: "搜索" }
];

interface ProjectDragState {
  sourceId: string;
  targetId?: string;
  placement?: ProjectDragPlacement;
  section: "pinned" | "projects";
}

interface SidebarProps {
  layout: SidebarLayoutSnapshot;
  peekDrawerHandlers: SidebarPeekHandlers;
  peekDrawerRef: React.RefObject<HTMLElement | null>;
  peekTriggerHandlers: SidebarPeekHandlers;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
  onOpenProject(): void;
  onCreateEmptyProject(): void;
  onSelectSession(projectId: string, sessionId: string): void;
  onLoadSessionChildren(projectId: string, parentSessionId: string, cursor?: string): Promise<DesktopSessionTreePage>;
  onSessionMenu(session: DesktopSessionSummary): void;
  onProjectPinned(projectId: string, pinned: boolean): void;
  onReorderProjects(projectIds: string[]): void;
  onRefreshProject(projectId: string): void;
  onRevealProject(projectId: string): void;
  onOpenTerminalProject(projectId: string): void;
  onRenameProject(projectId: string): void;
  onNewTask(projectId: string): void;
  onRemoveProject(projectId: string): void;
  onExtensions(): void;
  onSearch(): void;
  onSettings(): void;
  onResizeKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onResizePointerDown: React.PointerEventHandler<HTMLDivElement>;
  onToggleSidebar(): void;
}

export const Sidebar = memo(function Sidebar({
  layout,
  peekDrawerHandlers,
  peekDrawerRef,
  peekTriggerHandlers,
  projects,
  sessions,
  activeProjectId,
  selectedSessionId,
  onOpenProject,
  onCreateEmptyProject,
  onSelectSession,
  onLoadSessionChildren,
  onSessionMenu,
  onProjectPinned,
  onReorderProjects,
  onRefreshProject,
  onRevealProject,
  onOpenTerminalProject,
  onRenameProject,
  onNewTask,
  onRemoveProject,
  onExtensions,
  onSearch,
  onSettings,
  onResizeKeyDown,
  onResizePointerDown,
  onToggleSidebar
}: SidebarProps): React.JSX.Element {
  const [expandedSections, setExpandedSections] = useState<Record<SidebarSectionName, boolean>>({
    pinned: true,
    projects: true,
    dialogue: true
  });
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());
  const [loadedSessionParents, setLoadedSessionParents] = useState<Set<string>>(() => new Set());
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionNextCursors, setSessionNextCursors] = useState<Map<string, string>>(() => new Map());
  const [projectMenuOpen, setProjectMenuOpen] = useState<string>();
  const [projectOrganizationMenuOpen, setProjectOrganizationMenuOpen] = useState(false);
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false);
  const [projectSort, setProjectSort] = useState<ProjectSort>("priority");
  const [dragState, setDragState] = useState<ProjectDragState | undefined>(undefined);
  const dragStateRef = useRef<ProjectDragState | undefined>(undefined);
  const projectOrganizationButtonRef = useRef<HTMLButtonElement>(null);
  const projectCreateButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!projectMenuOpen && !projectOrganizationMenuOpen && !projectCreateMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cindy-sidebar-menu-anchor, .cindy-sidebar-menu")) return;
      setProjectMenuOpen(undefined);
      setProjectOrganizationMenuOpen(false);
      setProjectCreateMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setProjectMenuOpen(undefined);
      setProjectOrganizationMenuOpen(false);
      setProjectCreateMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectCreateMenuOpen, projectMenuOpen, projectOrganizationMenuOpen]);

  useEffect(() => {
    if (layout.mode !== "collapsed" && !layout.resizing) return;
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setDragState(undefined);
    dragStateRef.current = undefined;
  }, [layout.mode, layout.resizing]);

  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, DesktopSessionSummary[]>();
    for (const session of sessions) {
      const group = grouped.get(session.projectId) ?? [];
      group.push(session);
      grouped.set(session.projectId, group);
    }
    return grouped;
  }, [sessions]);

  const dialogueSessions = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    return sessions.filter((session) => !session.pinned && !projectIds.has(session.projectId));
  }, [projects, sessions]);

  // 会话置顶与项目置顶相互独立；项目内的置顶会话统一提升到顶部置顶段。
  const pinnedSessions = useMemo(() => sessions.filter((session) => session.pinned), [sessions]);

  const orderedProjects = useMemo(() => sortProjects(projects, projectSort), [projects, projectSort]);
  const pinnedProjects = orderedProjects.filter((project) => project.pinned);
  const unpinnedProjects = orderedProjects.filter((project) => !project.pinned);
  const peekOpen = layout.mode === "peek";
  const contentVisible = layout.mode !== "collapsed";
  const compact = layout.mode === "rail";

  const toggleSection = (section: SidebarSectionName): void => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const selectOrToggleProject = (projectId: string): void => {
    // 文件夹只负责浏览会话树；只有点击具体 session 行，才允许聊天区切换内容。
    if (projectId !== activeProjectId) {
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      return;
    }
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const setProjectDragState = (next: ProjectDragState | undefined): void => {
    dragStateRef.current = next;
    setDragState(next);
  };

  const beginProjectDrag = (projectId: string, section: "pinned" | "projects"): void => {
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setProjectDragState({ sourceId: projectId, section });
  };

  const updateProjectDragTarget = (projectId: string, section: "pinned" | "projects", clientY: number, bounds: DOMRect): void => {
    const current = dragStateRef.current;
    if (!current || current.section !== section || current.sourceId === projectId) return;
    const placement: ProjectDragPlacement = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    if (current.targetId === projectId && current.placement === placement) return;
    setProjectDragState({ ...current, targetId: projectId, placement });
  };

  const dropProjectDrag = (targetId: string, clientY: number, bounds: DOMRect): void => {
    const current = dragStateRef.current;
    setProjectDragState(undefined);
    if (!current || current.sourceId === targetId) return;
    const placement: ProjectDragPlacement = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    const sectionProjects = current.section === "pinned" ? pinnedProjects : unpinnedProjects;
    const sectionIds = sectionProjects.map((project) => project.id);
    if (!sectionIds.includes(current.sourceId) || !sectionIds.includes(targetId)) return;
    const nextIds = reorderSectionProjectIds(
      orderedProjects.map((project) => project.id),
      sectionIds,
      current.sourceId,
      targetId,
      placement
    );
    if (nextIds.join("\0") === orderedProjects.map((project) => project.id).join("\0")) return;
    setProjectSort("manual");
    onReorderProjects(nextIds);
  };

  const projectDropClass = (projectId: string, section: "pinned" | "projects"): string => {
    if (!dragState || dragState.section !== section || dragState.targetId !== projectId || !dragState.placement) return "";
    return dragState.placement === "before" ? " is-drop-before" : " is-drop-after";
  };

  const createTask = (): void => {
    if (activeProjectId) onNewTask(activeProjectId);
    else onOpenProject();
  };

  const navActionHandlers: Record<SidebarNavAction, () => void> = {
    newTask: createTask,
    extensions: onExtensions,
    search: onSearch,
    settings: onSettings
  };

  const loadSessionChildren = async (session: DesktopSessionSummary, cursor?: string): Promise<void> => {
    if (!session.hasChildren || loadingSessionIds.has(session.id)) return;
    setLoadingSessionIds((current) => new Set(current).add(session.id));
    try {
      const page = await onLoadSessionChildren(session.projectId, session.id, cursor);
      setLoadedSessionParents((current) => new Set(current).add(session.id));
      setSessionNextCursors((current) => {
        const next = new Map(current);
        if (page.nextCursor) next.set(session.id, page.nextCursor);
        else next.delete(session.id);
        return next;
      });
    } finally {
      setLoadingSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  };

  const toggleSession = (session: DesktopSessionSummary): void => {
    if (!session.hasChildren) return;
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
    if (!expandedSessionIds.has(session.id) && !loadedSessionParents.has(session.id)) void loadSessionChildren(session);
  };

  const loadMoreSessionChildren = (session: DesktopSessionSummary): void => {
    const cursor = sessionNextCursors.get(session.id);
    if (cursor) void loadSessionChildren(session, cursor);
  };

  const renderProject = (project: DesktopProject, section: "pinned" | "projects"): React.JSX.Element => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];
    const displaySessions = projectSessions.filter((session) => !session.pinned);
    const expanded = project.id === activeProjectId
      ? !collapsedProjectIds.has(project.id)
      : expandedProjectIds.has(project.id);
    return (
      <div
        className={`cindy-project-group${dragState?.sourceId === project.id ? " is-dragging" : ""}${projectDropClass(project.id, section)}`}
        key={`${section}:${project.id}`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          updateProjectDragTarget(project.id, section, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dropProjectDrag(project.id, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
      >
        <ProjectRow
          dragActive={dragState?.sourceId === project.id}
          menuOpen={projectMenuOpen === `${section}:${project.id}`}
          onDragCancel={() => setProjectDragState(undefined)}
          onDragEnd={() => setProjectDragState(undefined)}
          onDragStart={() => beginProjectDrag(project.id, section)}
          onMenu={() => {
            setProjectOrganizationMenuOpen(false);
            setProjectCreateMenuOpen(false);
            setProjectMenuOpen((current) => current === `${section}:${project.id}` ? undefined : `${section}:${project.id}`);
          }}
          onNewTask={() => { setProjectMenuOpen(undefined); onNewTask(project.id); }}
          onOpenTerminal={() => { setProjectMenuOpen(undefined); onOpenTerminalProject(project.id); }}
          onPin={() => { setProjectMenuOpen(undefined); onProjectPinned(project.id, !project.pinned); }}
          onRefresh={() => { setProjectMenuOpen(undefined); onRefreshProject(project.id); }}
          onRemove={() => { setProjectMenuOpen(undefined); onRemoveProject(project.id); }}
          onRename={() => { setProjectMenuOpen(undefined); onRenameProject(project.id); }}
          onReveal={() => { setProjectMenuOpen(undefined); onRevealProject(project.id); }}
          onSelect={selectOrToggleProject}
          project={project}
          running={project.id === activeProjectId && hasRunningSession(projectSessions)}
          selected={project.id === activeProjectId && !selectedSessionId}
          sessionsExpanded={expanded}
        />
        {expanded ? (
          <ProjectSessions
            onSelectSession={onSelectSession}
            onSessionMenu={onSessionMenu}
            projectId={project.id}
            selectedSessionId={selectedSessionId}
            sessions={displaySessions}
            expandedSessionIds={expandedSessionIds}
            loadingSessionIds={loadingSessionIds}
            sessionNextCursors={sessionNextCursors}
            onToggleSession={toggleSession}
            onLoadMoreSessionChildren={loadMoreSessionChildren}
          />
        ) : null}
      </div>
    );
  };

  return (
    <>
      {!contentVisible ? <div aria-hidden="true" className="cindy-sidebar-peek-trigger" {...peekTriggerHandlers} /> : null}
      <aside
        aria-label="主导航"
        aria-hidden={contentVisible ? undefined : true}
        className={`cindy-sidebar${contentVisible ? "" : " is-hidden"}${compact ? " is-compact" : ""}${layout.resizing ? " is-resizing" : ""}${peekOpen ? ` is-peek-overlay is-peek-${layout.transition === "peek-closing" ? "closing" : layout.transition === "pinning" ? "pinning" : "peeking"}` : ""}`}
        ref={peekOpen ? peekDrawerRef : undefined}
        style={{
          width: "var(--cindy-sidebar-animated-visual-width)"
        }}
        onPointerEnter={peekOpen ? peekDrawerHandlers.onPointerEnter : undefined}
        onPointerLeave={peekOpen ? peekDrawerHandlers.onPointerLeave : undefined}
        onPointerMove={peekOpen ? peekDrawerHandlers.onPointerMove : undefined}
        onPointerDown={peekOpen ? peekDrawerHandlers.onPointerDown : undefined}
        onPointerUp={peekOpen ? peekDrawerHandlers.onPointerUp : undefined}
      >
        {/* 顶部行是侧栏内容的固定锚点；收起时也保留它，避免导航内容向上跳 46px。 */}
        <div aria-hidden="true" className="cindy-sidebar-topbar-spacer" />

      <div className="cindy-sidebar-body">
        <div className="cindy-sidebar-scroll">
          <nav aria-label="功能导航" className="cindy-sidebar-nav">
            {SIDEBAR_NAV_ITEMS.map((item) => (
              <button
                aria-disabled={item.disabled ? "true" : undefined}
                aria-label={item.label}
                className={`cindy-sidebar-nav-item${item.action === "newTask" ? " cindy-sidebar-nav-new-button" : ""}`}
                disabled={item.disabled}
                key={item.label}
                onClick={item.action ? navActionHandlers[item.action] : undefined}
                title={item.title}
                type="button"
              >
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          {pinnedProjects.length || pinnedSessions.length ? (
            <SidebarSection expanded={expandedSections.pinned} label="置顶" onToggle={() => toggleSection("pinned")}>
              {/* 置顶会话排在置顶文件夹之前，避免文件夹把会话顶到下面。 */}
              <SessionList
                onSelectSession={onSelectSession}
                onSessionMenu={onSessionMenu}
                selectedSessionId={selectedSessionId}
                sessions={pinnedSessions}
                expandedSessionIds={expandedSessionIds}
                loadingSessionIds={loadingSessionIds}
                sessionNextCursors={sessionNextCursors}
                onToggleSession={toggleSession}
                onLoadMoreSessionChildren={loadMoreSessionChildren}
              />
              {pinnedProjects.map((project) => renderProject(project, "pinned"))}
            </SidebarSection>
          ) : null}

          <SidebarSection
            actions={(
              <div className="cindy-sidebar-section-actions cindy-sidebar-menu-anchor">
                <button
                  ref={projectOrganizationButtonRef}
                  aria-label="项目排序"
                  className="cindy-sidebar-section-action"
                  onClick={() => {
                    setProjectMenuOpen(undefined);
                    setProjectCreateMenuOpen(false);
                    setProjectOrganizationMenuOpen((current) => !current);
                  }}
                  type="button"
                >
                  <Icon name="more" size={14} />
                </button>
                <button
                  ref={projectCreateButtonRef}
                  aria-label="添加项目"
                  className="cindy-sidebar-section-action"
                  onClick={() => {
                    setProjectMenuOpen(undefined);
                    setProjectOrganizationMenuOpen(false);
                    setProjectCreateMenuOpen((current) => !current);
                  }}
                  type="button"
                >
                  <Icon name="add" size={15} />
                </button>
                {projectOrganizationMenuOpen ? (
                  <SidebarOrganizationMenu
                    anchorRef={projectOrganizationButtonRef}
                    onSortChange={(value) => { setProjectSort(value); setProjectOrganizationMenuOpen(false); }}
                    sort={projectSort}
                  />
                ) : null}
                {projectCreateMenuOpen ? (
                  <SidebarCreationMenu
                    anchorRef={projectCreateButtonRef}
                    onCreateEmptyProject={() => { setProjectCreateMenuOpen(false); onCreateEmptyProject(); }}
                    onOpenProject={() => { setProjectCreateMenuOpen(false); onOpenProject(); }}
                  />
                ) : null}
              </div>
            )}
            expanded={expandedSections.projects}
            icon="folder"
            label="项目"
            compactDivider
            onToggle={() => toggleSection("projects")}
          >
            {unpinnedProjects.length ? unpinnedProjects.map((project) => renderProject(project, "projects")) : <div className="cindy-sidebar-empty-row">暂无项目，点击 + 添加</div>}
          </SidebarSection>

          <SidebarSection expanded={expandedSections.dialogue} icon="message" label="对话" onToggle={() => toggleSection("dialogue")}>
            <CollapsibleSessionList
              limit={DIALOGUE_SESSION_COLLAPSE_LIMIT}
              onSelectSession={onSelectSession}
              onSessionMenu={onSessionMenu}
              selectedSessionId={selectedSessionId}
              sessions={dialogueSessions}
              expandedSessionIds={expandedSessionIds}
              loadingSessionIds={loadingSessionIds}
              sessionNextCursors={sessionNextCursors}
              onToggleSession={toggleSession}
              onLoadMoreSessionChildren={loadMoreSessionChildren}
            />
            {!dialogueSessions.length ? <p className="cindy-sidebar-empty-row">暂无未归类对话</p> : null}
          </SidebarSection>
        </div>
      </div>

      <div className="cindy-sidebar-footer">
        <button aria-label="设置" className="cindy-sidebar-settings-item" onClick={onSettings} type="button">
          <Icon name="settings" size={16} />
          <span>设置</span>
        </button>
      </div>
      {contentVisible ? (
        <div
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={SIDEBAR_RAIL_WIDTH}
          aria-valuenow={layout.visualWidth}
          className="cindy-sidebar-resizer"
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizePointerDown}
          role="separator"
          tabIndex={0}
        />
      ) : null}
      </aside>
      <SidebarChrome
        collapsed={!contentVisible}
        floating
        onNewTask={createTask}
        onToggle={onToggleSidebar}
      />
    </>
  );
});

function SidebarChrome({ collapsed, floating = false, onNewTask, onToggle }: { collapsed: boolean; floating?: boolean; onNewTask(): void; onToggle(): void }): React.JSX.Element {
  return (
    <>
      {floating ? <div aria-hidden="true" className="cindy-sidebar-topbar-visual" /> : null}
      <div className={`cindy-sidebar-topbar${floating ? " cindy-sidebar-topbar-floating" : ""}`}>
        <div className={floating ? "cindy-sidebar-topbar-hit-layer" : undefined}>
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            className="cindy-chrome-button"
            onClick={onToggle}
            type="button"
          >
            <Icon name="sidebar" size={15} />
          </button>
          <button
            aria-label="新建对话"
            className="cindy-chrome-button cindy-sidebar-new-button"
            onClick={onNewTask}
            type="button"
          >
            <Icon name="menu" size={16} />
          </button>
        </div>
      </div>
    </>
  );
}

function SidebarSection({ label, icon, compactDivider, expanded, actions, onToggle, children }: { label: string; icon?: IconName; compactDivider?: boolean; expanded: boolean; actions?: React.ReactNode; onToggle(): void; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-label={label} className={`cindy-sidebar-section${expanded ? " is-expanded" : ""}${icon ? " has-compact-icon" : ""}${compactDivider ? " has-compact-divider" : ""}`}>
      <div className="cindy-sidebar-section-header">
        <button aria-expanded={expanded} aria-label={label} className="cindy-sidebar-section-trigger" onClick={onToggle} type="button">
          {icon ? <span aria-hidden="true" className="cindy-sidebar-section-icon"><Icon name={icon} size={17} /></span> : null}
          <span className="cindy-sidebar-section-label">{label}</span>
          <span className="cindy-sidebar-section-chevron"><Icon name="chevron" size={13} /></span>
        </button>
        {actions}
      </div>
      <div className="cindy-sidebar-section-content"><div>{children}</div></div>
    </section>
  );
}

function ProjectSessions({ projectId, sessions, selectedSessionId, onSelectSession, onSessionMenu, expandedSessionIds, loadingSessionIds, sessionNextCursors, onToggleSession, onLoadMoreSessionChildren }: { projectId: string; sessions: DesktopSessionSummary[]; selectedSessionId?: string; onSelectSession(projectId: string, sessionId: string): void; onSessionMenu(session: DesktopSessionSummary): void; expandedSessionIds: Set<string>; loadingSessionIds: Set<string>; sessionNextCursors: Map<string, string>; onToggleSession(session: DesktopSessionSummary): void; onLoadMoreSessionChildren(session: DesktopSessionSummary): void }): React.JSX.Element | null {
  if (!sessions.length) return <div className="cindy-sidebar-empty-row cindy-sidebar-project-empty">没有聊天</div>;
  return (
    <CollapsibleSessionList
      limit={PROJECT_SESSION_COLLAPSE_LIMIT}
      onSelectSession={onSelectSession}
      onSessionMenu={onSessionMenu}
      projectId={projectId}
      selectedSessionId={selectedSessionId}
      sessions={sessions}
      expandedSessionIds={expandedSessionIds}
      loadingSessionIds={loadingSessionIds}
      sessionNextCursors={sessionNextCursors}
      onToggleSession={onToggleSession}
      onLoadMoreSessionChildren={onLoadMoreSessionChildren}
    />
  );
}

interface SessionListProps {
  projectId?: string;
  sessions: DesktopSessionSummary[];
  selectedSessionId?: string;
  onSelectSession(projectId: string, sessionId: string): void;
  onSessionMenu(session: DesktopSessionSummary): void;
  expandedSessionIds: Set<string>;
  loadingSessionIds: Set<string>;
  sessionNextCursors: Map<string, string>;
  onToggleSession(session: DesktopSessionSummary): void;
  onLoadMoreSessionChildren(session: DesktopSessionSummary): void;
}

function CollapsibleSessionList({ limit, ...props }: SessionListProps & { limit: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = props.sessions.length > limit;
  useEffect(() => {
    if (!shouldCollapse) setExpanded(false);
  }, [shouldCollapse]);
  const visibleSessions = expanded ? props.sessions : props.sessions.slice(0, limit);
  return (
    <>
      <SessionList {...props} sessions={visibleSessions} />
      {shouldCollapse ? (
        <button className="cindy-sidebar-session-expand" onClick={() => setExpanded((current) => !current)} type="button">
          {expanded ? "收起" : `显示全部 ${props.sessions.length} 项`}
        </button>
      ) : null}
    </>
  );
}

function SessionList({ projectId, sessions, selectedSessionId, onSelectSession, onSessionMenu, expandedSessionIds, loadingSessionIds, sessionNextCursors, onToggleSession, onLoadMoreSessionChildren }: SessionListProps): React.JSX.Element {
  const byParent = new Map<string | undefined, DesktopSessionSummary[]>();
  const ids = new Set(sessions.map((session) => session.id));
  for (const session of sessions) {
    const parent = session.parentSessionId && ids.has(session.parentSessionId) ? session.parentSessionId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(session);
    byParent.set(parent, siblings);
  }
  const renderNode = (session: DesktopSessionSummary, depth: number, ancestors: Set<string>): React.JSX.Element[] => {
    if (ancestors.has(session.id)) return [];
    const nextAncestors = new Set(ancestors).add(session.id);
    const expanded = expandedSessionIds.has(session.id);
    const children = expanded ? (byParent.get(session.id) ?? []).flatMap((child) => renderNode(child, depth + 1, nextAncestors)) : [];
    const nextCursor = sessionNextCursors.get(session.id);
    return [
      <div className="cindy-sidebar-session-tree-row" key={`${session.projectId}:${session.id}`}>
        <button
          aria-expanded={session.hasChildren ? expanded : undefined}
          aria-label={session.hasChildren ? (expanded ? "收起子会话" : "展开子会话") : undefined}
          className={`cindy-sidebar-session-toggle${session.hasChildren ? "" : " is-empty"}`}
          disabled={!session.hasChildren || loadingSessionIds.has(session.id)}
          onClick={() => onToggleSession(session)}
          style={{ marginLeft: `${depth * 16}px` }}
          type="button"
        >
          {loadingSessionIds.has(session.id) ? "…" : session.hasChildren ? <Icon name="chevron" size={12} /> : null}
        </button>
        <button
          aria-current={session.id === selectedSessionId ? "page" : undefined}
          className={`cindy-sidebar-session-item${session.id === selectedSessionId ? " is-selected" : ""}${session.archived ? " is-archived" : ""}`}
          onClick={() => onSelectSession(projectId ?? session.projectId, session.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onSessionMenu(session);
          }}
          title={session.firstUserMessage || session.title}
          type="button"
        >
          {session.unread ? <span aria-label="未读" className="cindy-sidebar-session-unread" /> : null}
          <span className="cindy-sidebar-session-title">{session.title || session.firstUserMessage || "新对话"}</span>
        </button>
      </div>,
      ...children,
      ...(expanded && nextCursor ? [
        <button className="cindy-sidebar-session-expand" key={`${session.projectId}:${session.id}:more`} onClick={() => onLoadMoreSessionChildren(session)} type="button">
          加载更多子会话
        </button>
      ] : [])
    ];
  };
  return (
    <div className={`cindy-sidebar-session-list${projectId ? " is-indented" : ""}`}>
      {(byParent.get(undefined) ?? []).flatMap((session) => renderNode(session, 0, new Set()))}
    </div>
  );
}

const ProjectRow = memo(function ProjectRow({
  project,
  selected,
  sessionsExpanded,
  running,
  dragActive,
  menuOpen,
  onSelect,
  onMenu,
  onNewTask,
  onPin,
  onRefresh,
  onReveal,
  onOpenTerminal,
  onRename,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragCancel
}: {
  project: DesktopProject;
  selected: boolean;
  sessionsExpanded: boolean;
  running: boolean;
  dragActive: boolean;
  menuOpen: boolean;
  onSelect(projectId: string): void;
  onMenu(): void;
  onNewTask(): void;
  onPin(): void;
  onRefresh(): void;
  onReveal(): void;
  onOpenTerminal(): void;
  onRename(): void;
  onRemove(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragCancel(): void;
}): React.JSX.Element {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  return (
    <div
      className={`cindy-project-row-wrap${selected ? " is-active" : ""}${dragActive ? " is-drag-active" : ""}`}
      draggable
      onDragEnd={(event) => {
        event.preventDefault();
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        onDragEnd();
      }}
      onDragStart={(event) => {
        if (event.target instanceof Element && event.target.closest(".cindy-project-row-actions")) {
          event.preventDefault();
          return;
        }
        suppressClickRef.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", project.id);
        onDragStart();
      }}
      onKeyDown={(event) => { if (event.key === "Escape" && dragActive) onDragCancel(); }}
    >
      <div
        aria-expanded={sessionsExpanded}
        className={`cindy-project-row${selected ? " is-active" : ""}`}
        onClick={() => { if (!suppressClickRef.current) onSelect(project.id); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect(project.id);
        }}
        title={project.path}
        role="button"
        tabIndex={0}
      >
        <Icon name={sessionsExpanded ? "folder-open" : "folder"} size={15} />
        <span className="cindy-project-row-label">{project.name}</span>
        {project.missing ? <span className="cindy-project-status is-failed" title="路径不可用" /> : running ? <span className="cindy-project-status is-running" title="正在运行" /> : null}
      </div>
      <div className={`cindy-project-row-actions${menuOpen ? " is-open" : ""} cindy-sidebar-menu-anchor`}>
        <button aria-label={`新建任务 ${project.name}`} className="cindy-project-row-action" onClick={onNewTask} title="新建任务" type="button"><Icon name="edit" size={14} /></button>
        <button ref={menuButtonRef} aria-label={`${project.name} 项目操作`} className="cindy-project-row-action" onClick={onMenu} title="项目操作" type="button"><Icon name="more" size={14} /></button>
        {menuOpen ? <ProjectMenu anchorRef={menuButtonRef} onOpenTerminal={onOpenTerminal} onPin={onPin} onRefresh={onRefresh} onRemove={onRemove} onRename={onRename} onReveal={onReveal} project={project} /> : null}
      </div>
    </div>
  );
});

function ProjectMenu({ anchorRef, project, onPin, onRefresh, onReveal, onOpenTerminal, onRename, onRemove }: { anchorRef: FloatingMenuAnchor; project: DesktopProject; onPin(): void; onRefresh(): void; onReveal(): void; onOpenTerminal(): void; onRename(): void; onRemove(): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="项目操作菜单">
      <button onClick={onPin} role="menuitem" type="button"><Icon name="pin" size={15} /><span>{project.pinned ? "取消置顶项目" : "置顶项目"}</span></button>
      <button onClick={onRefresh} role="menuitem" type="button"><Icon name="refresh" size={15} /><span>刷新项目状态</span></button>
      <button onClick={onReveal} role="menuitem" type="button"><Icon name="external" size={15} /><span>在 Finder 中显示</span></button>
      <button onClick={onOpenTerminal} role="menuitem" type="button"><Icon name="terminal" size={15} /><span>在终端中打开</span></button>
      <button onClick={onRename} role="menuitem" type="button"><Icon name="edit" size={15} /><span>重命名项目</span></button>
      <div className="cindy-sidebar-menu-separator" />
      <button className="is-danger" onClick={onRemove} role="menuitem" type="button"><Icon name="trash" size={15} /><span>移除项目</span></button>
    </FloatingSidebarMenu>
  );
}

function SidebarOrganizationMenu({ anchorRef, sort, onSortChange }: { anchorRef: FloatingMenuAnchor; sort: ProjectSort; onSortChange(value: ProjectSort): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="项目排序菜单" className="is-narrow">
      <div className="cindy-sidebar-menu-heading">排序方式</div>
      {([
        ["priority", "优先级"],
        ["recent", "最近打开"],
        ["manual", "手动排序"]
      ] as const).map(([value, label]) => (
        <button aria-checked={sort === value} key={value} onClick={() => onSortChange(value)} role="menuitemradio" type="button">
          <span className="cindy-sidebar-menu-check">{sort === value ? <Icon name="check" size={14} /> : null}</span>
          <span>{label}</span>
        </button>
      ))}
    </FloatingSidebarMenu>
  );
}

function SidebarCreationMenu({ anchorRef, onCreateEmptyProject, onOpenProject }: { anchorRef: FloatingMenuAnchor; onCreateEmptyProject(): void; onOpenProject(): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="添加项目菜单">
      <button onClick={onCreateEmptyProject} role="menuitem" type="button"><Icon name="add" size={15} /><span>新建空项目</span></button>
      <button onClick={onOpenProject} role="menuitem" type="button"><Icon name="folder" size={15} /><span>使用现有文件夹</span></button>
    </FloatingSidebarMenu>
  );
}

function FloatingSidebarMenu({ anchorRef, ariaLabel, className = "", children }: { anchorRef: FloatingMenuAnchor; ariaLabel: string; className?: string; children: React.ReactNode }): React.JSX.Element {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const updatePosition = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = className === "is-narrow" ? 166 : 222;
      setPosition({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 300))
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, className]);
  return createPortal(
    <div aria-label={ariaLabel} className={`cindy-sidebar-menu${className ? ` ${className}` : ""}`} role="menu" style={{ left: position?.left, top: position?.top, visibility: position ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body
  );
}

function sortProjects(projects: DesktopProject[], sort: ProjectSort): DesktopProject[] {
  const ordered = [...projects];
  if (sort === "manual") return ordered;
  if (sort === "priority") return ordered.sort((left, right) => left.pinned === right.pinned ? 0 : left.pinned ? -1 : 1);
  return ordered.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.name.localeCompare(right.name));
}

function reorderSectionProjectIds(fullIds: string[], sectionIds: string[], sourceId: string, targetId: string, placement: ProjectDragPlacement): string[] {
  const nextSection = sectionIds.filter((projectId) => projectId !== sourceId);
  const targetIndex = nextSection.indexOf(targetId);
  if (targetIndex < 0) return fullIds;
  nextSection.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  const sectionMembers = new Set(sectionIds);
  let sectionIndex = 0;
  return fullIds.map((projectId) => sectionMembers.has(projectId) ? nextSection[sectionIndex++]! : projectId);
}

function hasRunningSession(sessions: DesktopSessionSummary[]): boolean {
  return sessions.some((session) => session.status === "running" || session.status === "waiting_permission");
}
