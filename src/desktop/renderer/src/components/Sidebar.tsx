import { createPortal } from "react-dom";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopProject, DesktopSessionSummary } from "../../../protocol.js";
import { AppIcon } from "./AppIcon.js";
import { Icon } from "./Icon.js";

interface SidebarProps {
  visible: boolean;
  width: number;
  resizing: boolean;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(): void;
  onOpenProject(): void;
  onCreateEmptyProject(): void;
  onSelectProject(projectId: string): void;
  onSelectSession(sessionId: string): void;
  onProjectPinned(projectId: string, pinned: boolean): void;
  onReorderProjects(projectIds: string[]): void;
  onRevealProject(projectId: string): void;
  onRenameProject(projectId: string): void;
  onNewTask(projectId: string): void;
  onRemoveProject(projectId: string): void;
  onSearch(): void;
  onSettings(): void;
  onUnavailable(feature: string): void;
}

type ProjectDragPlacement = "before" | "after";

type ProjectDragState = {
  sourceId: string;
  targetId?: string;
  placement?: ProjectDragPlacement;
  section: "pinned" | "projects";
};

type SidebarSectionName = "pinned" | "projects";
type ProjectGrouping = "by-project" | "list";
type ProjectSort = "priority" | "recent" | "manual";
type FloatingMenuAnchor = { readonly current: HTMLElement | null };

export const Sidebar = memo(function Sidebar({
  visible,
  width,
  resizing,
  projects,
  sessions,
  activeProjectId,
  selectedSessionId,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  onOpenProject,
  onCreateEmptyProject,
  onSelectProject,
  onSelectSession,
  onProjectPinned,
  onReorderProjects,
  onRevealProject,
  onRenameProject,
  onNewTask,
  onRemoveProject,
  onSearch,
  onSettings,
  onUnavailable
}: SidebarProps): React.JSX.Element {
  const [expandedSections, setExpandedSections] = useState<Record<SidebarSectionName, boolean>>({ pinned: true, projects: true });
  const [projectMenuOpen, setProjectMenuOpen] = useState<string>();
  const [projectOrganizationMenuOpen, setProjectOrganizationMenuOpen] = useState(false);
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false);
  const [projectGrouping, setProjectGrouping] = useState<ProjectGrouping>("by-project");
  const [projectSort, setProjectSort] = useState<ProjectSort>("priority");
  const [collapsedProjectIds, setCollapsedProjectIds] = useState(() => new Set<string>());
  const [dragState, setDragState] = useState<ProjectDragState | undefined>();
  const dragStateRef = useRef<ProjectDragState | undefined>(undefined);
  const projectOrganizationButtonRef = useRef<HTMLButtonElement>(null);
  const projectCreateButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!projectMenuOpen && !projectOrganizationMenuOpen && !projectCreateMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".sidebar-menu-anchor, .project-row-actions, .project-menu")) return;
      setProjectMenuOpen(undefined);
      setProjectOrganizationMenuOpen(false);
      setProjectCreateMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setProjectMenuOpen(undefined);
        setProjectOrganizationMenuOpen(false);
        setProjectCreateMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectCreateMenuOpen, projectMenuOpen, projectOrganizationMenuOpen]);

  useEffect(() => {
    if (visible) return;
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
  }, [visible]);

  const orderedProjects = sortProjects(projects, projectSort);
  const pinnedProjects = orderedProjects.filter((project) => project.pinned);
  const unpinnedProjects = orderedProjects.filter((project) => !project.pinned);

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

  const endProjectDrag = (): void => {
    // Commit only on drop; dragend without drop cancels quietly.
    setProjectDragState(undefined);
  };

  const cancelProjectDrag = (): void => {
    setProjectDragState(undefined);
  };

  const projectDropClass = (projectId: string, section: "pinned" | "projects"): string => {
    if (!dragState || dragState.section !== section || dragState.targetId !== projectId || !dragState.placement) return "";
    return dragState.placement === "before" ? " is-drop-before" : " is-drop-after";
  };

  const toggleSection = (section: SidebarSectionName): void => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const openProjectMenu = (menuKey: string): void => {
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setProjectMenuOpen((current) => current === menuKey ? undefined : menuKey);
  };

  const toggleProjectOrganizationMenu = (): void => {
    setProjectMenuOpen(undefined);
    setProjectCreateMenuOpen(false);
    setProjectOrganizationMenuOpen((current) => !current);
  };

  const toggleProjectCreateMenu = (): void => {
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen((current) => !current);
  };

  const selectOrToggleProject = (projectId: string): void => {
    if (projectId !== activeProjectId) {
      setCollapsedProjectIds((current) => {
        if (!current.has(projectId)) return current;
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
      onSelectProject(projectId);
      return;
    }
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <aside className={`sidebar t-resize${visible ? "" : " is-hidden"}${resizing ? " is-resizing" : ""}`} style={{ width: visible ? width : 0 }}>
      <div aria-hidden={!visible} className="sidebar-surface" inert={!visible}>
        <div className="sidebar-titlebar-drag" />
        <div className="sidebar-brand">
          <div className="sidebar-brand-name"><AppIcon size={24} /><span>Biny</span></div>
          <button aria-label="搜索" className="icon-button" onClick={onSearch} type="button"><Icon name="search" /></button>
        </div>

        <div className="sidebar-scroll">
          {pinnedProjects.length ? (
            <SidebarFolder
              expanded={expandedSections.pinned}
              label="置顶"
              onToggle={() => toggleSection("pinned")}
            >
              {pinnedProjects.map((project) => (
                <div
                  className={`project-group${dragState?.sourceId === project.id ? " is-dragging" : ""}${projectDropClass(project.id, "pinned")}`}
                  key={`pinned-${project.id}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const bounds = event.currentTarget.getBoundingClientRect();
                    updateProjectDragTarget(project.id, "pinned", event.clientY, bounds);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dropProjectDrag(project.id, event.clientY, event.currentTarget.getBoundingClientRect());
                  }}
                >
                  <ProjectRow
                    dragActive={Boolean(dragState)}
                    menuOpen={projectMenuOpen === `pinned-${project.id}`}
                    onDragCancel={cancelProjectDrag}
                    onDragEnd={endProjectDrag}
                    onDragStart={() => beginProjectDrag(project.id, "pinned")}
                    onMenu={() => openProjectMenu(`pinned-${project.id}`)}
                    onPin={() => { setProjectMenuOpen(undefined); onProjectPinned(project.id, !project.pinned); }}
                    onReveal={() => { setProjectMenuOpen(undefined); onRevealProject(project.id); }}
                    onRename={() => { setProjectMenuOpen(undefined); onRenameProject(project.id); }}
                    onNewTask={() => { setProjectMenuOpen(undefined); onNewTask(project.id); }}
                    onArchive={() => { setProjectMenuOpen(undefined); onUnavailable("归档任务"); }}
                    onRemove={() => { setProjectMenuOpen(undefined); onRemoveProject(project.id); }}
                    onSelect={selectOrToggleProject}
                    project={project}
                    running={project.id === activeProjectId && hasRunningSession(sessions)}
                    selected={project.id === activeProjectId && !selectedSessionId}
                    sessionsExpanded={project.id === activeProjectId && !collapsedProjectIds.has(project.id)}
                  />
                  {project.id === activeProjectId ? <ProjectSessions expanded={!collapsedProjectIds.has(project.id)} onSelectSession={onSelectSession} selectedSessionId={selectedSessionId} sessions={sessions} /> : null}
                </div>
              ))}
            </SidebarFolder>
          ) : null}

          <SidebarFolder
            actions={(
              <div className="folder-section-actions sidebar-menu-anchor">
                <button ref={projectOrganizationButtonRef} aria-label="项目整理和排序" className="section-action" onClick={toggleProjectOrganizationMenu} type="button"><Icon name="more" size={14} /></button>
                <button ref={projectCreateButtonRef} aria-label="添加项目" className="section-action" onClick={toggleProjectCreateMenu} type="button"><Icon name="add" size={15} /></button>
                {projectOrganizationMenuOpen ? <ProjectOrganizationMenu anchorRef={projectOrganizationButtonRef} grouping={projectGrouping} onGroupingChange={(value) => { setProjectGrouping(value); setProjectOrganizationMenuOpen(false); }} onSortChange={(value) => { setProjectSort(value); setProjectOrganizationMenuOpen(false); }} sort={projectSort} /> : null}
                {projectCreateMenuOpen ? (
                  <ProjectCreationMenu
                    anchorRef={projectCreateButtonRef}
                    onCreateEmptyProject={() => { setProjectCreateMenuOpen(false); onCreateEmptyProject(); }}
                    onOpenProject={() => { setProjectCreateMenuOpen(false); onOpenProject(); }}
                  />
                ) : null}
              </div>
            )}
            expanded={expandedSections.projects}
            label="项目"
            onToggle={() => toggleSection("projects")}
          >
            {unpinnedProjects.map((project) => {
              return (
                <div
                  className={`project-group${dragState?.sourceId === project.id ? " is-dragging" : ""}${projectDropClass(project.id, "projects")}`}
                  key={project.id}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const bounds = event.currentTarget.getBoundingClientRect();
                    updateProjectDragTarget(project.id, "projects", event.clientY, bounds);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dropProjectDrag(project.id, event.clientY, event.currentTarget.getBoundingClientRect());
                  }}
                >
                  <ProjectRow
                    dragActive={Boolean(dragState)}
                    menuOpen={projectMenuOpen === `project-${project.id}`}
                    onDragCancel={cancelProjectDrag}
                    onDragEnd={endProjectDrag}
                    onDragStart={() => beginProjectDrag(project.id, "projects")}
                    onMenu={() => openProjectMenu(`project-${project.id}`)}
                    onPin={() => { setProjectMenuOpen(undefined); onProjectPinned(project.id, !project.pinned); }}
                    onReveal={() => { setProjectMenuOpen(undefined); onRevealProject(project.id); }}
                    onRename={() => { setProjectMenuOpen(undefined); onRenameProject(project.id); }}
                    onNewTask={() => { setProjectMenuOpen(undefined); onNewTask(project.id); }}
                    onArchive={() => { setProjectMenuOpen(undefined); onUnavailable("归档任务"); }}
                    onRemove={() => { setProjectMenuOpen(undefined); onRemoveProject(project.id); }}
                    onSelect={selectOrToggleProject}
                    project={project}
                    running={project.id === activeProjectId && hasRunningSession(sessions)}
                    selected={project.id === activeProjectId && !selectedSessionId}
                    sessionsExpanded={project.id === activeProjectId && !collapsedProjectIds.has(project.id)}
                  />
                  {project.id === activeProjectId ? <ProjectSessions expanded={!collapsedProjectIds.has(project.id)} onSelectSession={onSelectSession} selectedSessionId={selectedSessionId} sessions={sessions} /> : null}
                </div>
              );
            })}
            {!projects.length ? <div className="empty-folder-row">暂无项目，点击 + 添加</div> : null}
          </SidebarFolder>
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-settings-button" onClick={onSettings} type="button"><Icon name="settings" size={15} /><span>设置</span></button>
        </div>
        <SidebarResizer onResizeEnd={onResizeEnd} onResizeStart={onResizeStart} onWidthChange={onWidthChange} width={width} />
      </div>
    </aside>
  );
});

function SidebarFolder({ label, expanded, actions, onToggle, children }: { label: string; expanded: boolean; actions?: React.ReactNode; onToggle(): void; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`sidebar-section folder-section${expanded ? " is-expanded" : ""}`}>
      <div className="folder-section-heading">
        <button aria-expanded={expanded} className="folder-section-trigger" onClick={onToggle} type="button">
          <span>{label}</span>
          <span className="folder-section-chevron"><Icon name="chevron" size={13} /></span>
        </button>
        {actions}
      </div>
      <div className="folder-section-content t-resize"><div className="folder-section-content-inner">{children}</div></div>
    </section>
  );
}

function ProjectSessions({ sessions, selectedSessionId, expanded, onSelectSession }: { sessions: DesktopSessionSummary[]; selectedSessionId?: string; expanded: boolean; onSelectSession(sessionId: string): void }): React.JSX.Element | null {
  if (!sessions.length) return null;
  return (
    <div aria-hidden={!expanded} aria-label="项目会话" className={`project-sessions t-resize${expanded ? " is-expanded" : ""}`} inert={!expanded}>
      <div>
        {sessions.map((session) => (
          <div className={`session-row${session.id === selectedSessionId ? " is-selected" : ""}`} key={session.id}>
            <button aria-current={session.id === selectedSessionId ? "page" : undefined} className="session-main" onClick={() => onSelectSession(session.id)} title={session.firstUserMessage || session.title} type="button">
              <span className="row-label">{session.title}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const ProjectRow = memo(function ProjectRow({
  project,
  selected,
  sessionsExpanded,
  running,
  dragActive,
  onSelect,
  menuOpen,
  onMenu,
  onRename,
  onNewTask,
  onPin,
  onReveal,
  onArchive,
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
  onSelect(projectId: string): void;
  menuOpen: boolean;
  onMenu(): void;
  onRename(): void;
  onNewTask(): void;
  onPin(): void;
  onReveal(): void;
  onArchive(): void;
  onRemove(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragCancel(): void;
}): React.JSX.Element {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);

  return (
    <div
      className={`project-row-wrap${selected ? " is-active" : ""}${dragActive ? " is-drag-active" : ""}`}
      draggable
      onDragEnd={(event) => {
        event.preventDefault();
        // Suppress the trailing click that browsers emit after a drag gesture.
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        onDragEnd();
      }}
      onDragStart={(event) => {
        if (event.target instanceof Element && event.target.closest(".project-row-actions, button, a, input, textarea")) {
          event.preventDefault();
          return;
        }
        suppressClickRef.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", project.id);
        onDragStart();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && dragActive) onDragCancel();
      }}
    >
      <div
        aria-expanded={sessionsExpanded}
        className={`project-row${selected ? " is-active" : ""}`}
        onClick={() => {
          if (suppressClickRef.current) return;
          onSelect(project.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(project.id);
          }
        }}
        role="button"
        tabIndex={0}
        title={project.path}
      >
        <Icon name="folder" size={15} />
        <span className="row-label">{project.name}</span>
        {project.missing ? <span className="status-dot is-failed" title="路径不可用" /> : running ? <span className="status-dot is-running" title="正在运行" /> : null}
      </div>
      <div className={`project-row-actions${menuOpen ? " is-open" : ""}`}>
        <button ref={menuButtonRef} aria-label={`${project.name} 项目操作`} className="project-row-action" onClick={onMenu} type="button"><Icon name="more" size={14} /></button>
        <button aria-label={`新建任务 ${project.name}`} className="project-row-action" onClick={onNewTask} title="新建任务" type="button"><Icon name="edit" size={14} /></button>
        {menuOpen ? <ProjectMenu anchorRef={menuButtonRef} onArchive={onArchive} onPin={onPin} onRemove={onRemove} onRename={onRename} onReveal={onReveal} project={project} /> : null}
      </div>
    </div>
  );
});

function ProjectMenu({ anchorRef, project, onPin, onReveal, onRename, onArchive, onRemove }: { anchorRef: FloatingMenuAnchor; project: DesktopProject; onPin(): void; onReveal(): void; onRename(): void; onArchive(): void; onRemove(): void }): React.JSX.Element {
  return (
    <FloatingProjectMenu anchorRef={anchorRef} ariaLabel="项目操作菜单">
      <button onClick={onPin} role="menuitem" type="button"><Icon name="pin" size={15} /><span>{project.pinned ? "取消置顶项目" : "置顶项目"}</span></button>
      <button onClick={onReveal} role="menuitem" type="button"><Icon name="external" size={15} /><span>在 Finder 中显示</span></button>
      <button onClick={onRename} role="menuitem" type="button"><Icon name="edit" size={15} /><span>重命名项目</span></button>
      <button onClick={onArchive} role="menuitem" type="button"><Icon name="archive" size={15} /><span>归档任务</span></button>
      <div className="project-menu-separator" />
      <button className="is-danger" onClick={onRemove} role="menuitem" type="button"><Icon name="trash" size={15} /><span>移除</span></button>
    </FloatingProjectMenu>
  );
}

function ProjectOrganizationMenu({ anchorRef, grouping, sort, onGroupingChange, onSortChange }: { anchorRef: FloatingMenuAnchor; grouping: ProjectGrouping; sort: ProjectSort; onGroupingChange(value: ProjectGrouping): void; onSortChange(value: ProjectSort): void }): React.JSX.Element {
  return (
    <FloatingProjectMenu anchorRef={anchorRef} ariaLabel="项目整理和排序菜单" className="project-organization-menu">
      <div className="project-menu-heading">整理</div>
      <button aria-checked={grouping === "by-project"} onClick={() => onGroupingChange("by-project")} role="menuitemradio" type="button"><MenuCheck checked={grouping === "by-project"} /><span>按项目</span></button>
      <button aria-checked={grouping === "list"} onClick={() => onGroupingChange("list")} role="menuitemradio" type="button"><MenuCheck checked={grouping === "list"} /><span>在一个列表中</span></button>
      <div className="project-menu-separator" />
      <div className="project-menu-heading">排序方式</div>
      <button aria-checked={sort === "priority"} onClick={() => onSortChange("priority")} role="menuitemradio" type="button"><MenuCheck checked={sort === "priority"} /><span>优先级</span></button>
      <button aria-checked={sort === "recent"} onClick={() => onSortChange("recent")} role="menuitemradio" type="button"><MenuCheck checked={sort === "recent"} /><span>最近更新</span></button>
      <button aria-checked={sort === "manual"} onClick={() => onSortChange("manual")} role="menuitemradio" type="button"><MenuCheck checked={sort === "manual"} /><span>手动排序</span></button>
    </FloatingProjectMenu>
  );
}

function MenuCheck({ checked }: { checked: boolean }): React.JSX.Element {
  return <span aria-hidden="true" className="project-menu-check">{checked ? <Icon name="check" size={14} /> : null}</span>;
}

function sortProjects(projects: DesktopProject[], sort: ProjectSort): DesktopProject[] {
  const ordered = [...projects];
  if (sort === "manual") return ordered;
  if (sort === "priority") {
    // Pinned first; keep existing relative order within each group so selecting a project never reorders the list.
    return ordered.sort((left, right) => {
      if (left.pinned === right.pinned) return 0;
      return left.pinned ? -1 : 1;
    });
  }
  return ordered.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.name.localeCompare(right.name));
}

function reorderSectionProjectIds(
  fullIds: string[],
  sectionIds: string[],
  sourceId: string,
  targetId: string,
  placement: ProjectDragPlacement
): string[] {
  const nextSection = sectionIds.filter((projectId) => projectId !== sourceId);
  const targetIndex = nextSection.indexOf(targetId);
  if (targetIndex < 0) return fullIds;
  nextSection.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);

  const sectionMembers = new Set(sectionIds);
  let sectionIndex = 0;
  return fullIds.map((projectId) => sectionMembers.has(projectId) ? nextSection[sectionIndex++]! : projectId);
}

function ProjectCreationMenu({ anchorRef, onCreateEmptyProject, onOpenProject }: { anchorRef: FloatingMenuAnchor; onCreateEmptyProject(): void; onOpenProject(): void }): React.JSX.Element {
  return (
    <FloatingProjectMenu anchorRef={anchorRef} ariaLabel="添加项目菜单" className="project-create-menu">
      <button onClick={onCreateEmptyProject} role="menuitem" type="button"><Icon name="add" size={15} /><span>新建空项目</span></button>
      <button onClick={onOpenProject} role="menuitem" type="button"><Icon name="folder" size={15} /><span>使用现有文件夹</span></button>
    </FloatingProjectMenu>
  );
}

function FloatingProjectMenu({ anchorRef, ariaLabel, className = "", children }: { anchorRef: FloatingMenuAnchor; ariaLabel: string; className?: string; children: React.ReactNode }): React.JSX.Element {
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    const updatePosition = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({ left: Math.max(8, rect.left), top: rect.bottom + 4 });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div aria-label={ariaLabel} className={`project-menu t-dropdown is-open${className ? ` ${className}` : ""}`} data-origin="top-left" role="menu" style={{ left: position?.left, top: position?.top, visibility: position ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body
  );
}

function hasRunningSession(sessions: DesktopSessionSummary[]): boolean {
  return sessions.some((session) => session.status === "running" || session.status === "waiting_permission");
}

function SidebarResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: { width: number; onWidthChange(width: number): void; onResizeStart(): void; onResizeEnd(): void }): React.JSX.Element {
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    onResizeStart();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent): void => onWidthChange(Math.min(300, Math.max(188, startWidth + moveEvent.clientX - startX)));
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onResizeEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  return <div aria-label="调整侧边栏宽度" className="sidebar-resizer" onPointerDown={startResize} role="separator" />;
}
