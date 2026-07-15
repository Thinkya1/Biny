import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRunMode } from "../../../agent/AgentSession.js";
import type { ModelRuntimeInfo, ThinkingSelection } from "../../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import type { AgentHostEvent } from "../../../runtime/agentEvents.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopAttachment,
  DesktopMenuAction,
  DesktopModelConfigurationInput,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import {
  canNavigateBack,
  canNavigateForward,
  createNavigationState,
  moveNavigation,
  pushNavigation,
  replaceNavigation,
  type DesktopNavigationState,
  type DesktopNavigationTarget
} from "./navigationHistory.js";
import { buildSessionTimeline } from "./sessionTimeline.js";
import { Composer } from "./components/Composer.js";
import { RenameOverlay, SearchOverlay, SettingsOverlay, Toast } from "./components/Overlays.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace } from "./components/Workspace.js";

interface RenameTarget {
  kind: "project" | "session";
  projectId: string;
  sessionId?: string;
  title: string;
}

export function App(): React.JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [workspace, setWorkspace] = useState<DesktopWorkspaceSnapshot>();
  const [document, setDocument] = useState<DesktopSessionDocument>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(216);
  const [focusToken, setFocusToken] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unavailableFeature, setUnavailableFeature] = useState<string>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [toast, setToast] = useState<string>();
  const [navigation, setNavigation] = useState<DesktopNavigationState>(createNavigationState);
  const selectedRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef(navigation);
  const loadRequestRef = useRef(0);
  const eventQueueRef = useRef<DesktopAgentEventEnvelope[]>([]);
  const eventFrameRef = useRef<number | undefined>(undefined);
  const refreshTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const menuActionRef = useRef<(action: DesktopMenuAction) => void>(() => undefined);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  const commitNavigation = useCallback((next: DesktopNavigationState): void => {
    navigationRef.current = next;
    setNavigation(next);
  }, []);

  const mergeWorkspaceProject = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setWorkspace(snapshot);
  }, []);

  const mergeProjectSnapshot = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    if (projectRef.current === snapshot.project.id) setWorkspace(snapshot);
  }, []);

  const openSession = useCallback(async (projectId: string, sessionId: string, showLoader = true): Promise<void> => {
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    setSelectedSessionId(sessionId);
    setUnavailableFeature(undefined);
    if (showLoader) setLoading(true);
    try {
      const nextDocument = await window.biny.openSession(projectId, sessionId);
      if (loadRequestRef.current === request) setDocument(nextDocument);
    } catch (error) {
      if (loadRequestRef.current === request) {
        setDocument(undefined);
        setToast(errorMessage(error));
      }
    } finally {
      if (loadRequestRef.current === request) setLoading(false);
    }
  }, []);

  const adoptWorkspace = useCallback(async (snapshot: DesktopWorkspaceSnapshot, preferredSessionId?: string): Promise<void> => {
    mergeWorkspaceProject(snapshot);
    const nextSessionId = preferredSessionId ?? snapshot.selectedSessionId;
    if (nextSessionId) await openSession(snapshot.project.id, nextSessionId);
    else {
      loadRequestRef.current += 1;
      setSelectedSessionId(undefined);
      setDocument(undefined);
      setLoading(false);
    }
  }, [mergeWorkspaceProject, openSession]);

  const openNavigationTarget = useCallback(async (target: DesktopNavigationTarget): Promise<void> => {
    if (target.sessionId === undefined) {
      await adoptWorkspace(await window.biny.startDraft(target.projectId));
      setFocusToken((value) => value + 1);
      return;
    }
    if (target.projectId === projectRef.current) {
      await openSession(target.projectId, target.sessionId);
      return;
    }
    await adoptWorkspace(await window.biny.selectProject(target.projectId), target.sessionId);
  }, [adoptWorkspace, openSession]);

  useEffect(() => {
    let active = true;
    void window.biny.bootstrap().then(async (bootstrap) => {
      if (!active) return;
      setVersion(bootstrap.version);
      setProjects(bootstrap.projects);
      setSidebarWidth(bootstrap.sidebarWidth);
      if (bootstrap.workspace) {
        mergeWorkspaceProject(bootstrap.workspace);
        const nextSessionId = bootstrap.selectedSessionId ?? bootstrap.workspace.selectedSessionId;
        if (nextSessionId) {
          await openSession(bootstrap.workspace.project.id, nextSessionId);
          commitNavigation(pushNavigation(createNavigationState(), { projectId: bootstrap.workspace.project.id, sessionId: nextSessionId }));
        }
        else setLoading(false);
      } else {
        setLoading(false);
      }
    }).catch((error) => {
      if (!active) return;
      setLoading(false);
      setToast(`Biny 启动失败：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [commitNavigation, mergeWorkspaceProject, openSession]);

  useEffect(() => {
    const refreshTimers = refreshTimersRef.current;
    const flushEvents = (): void => {
      eventFrameRef.current = undefined;
      const batch = eventQueueRef.current.splice(0);
      if (!batch.length) return;
      const activeProjectId = projectRef.current;
      const projectBatch = activeProjectId ? batch.filter((envelope) => envelope.projectId === activeProjectId) : [];
      if (projectBatch.length) {
        setWorkspace((current) => current && current.project.id === activeProjectId ? applyEventsToWorkspace(current, projectBatch.map((envelope) => envelope.event)) : current);
        const currentSessionId = selectedRef.current;
        if (currentSessionId) {
          const currentEvents = projectBatch.map((envelope) => envelope.event).filter((event) => event.sessionId === currentSessionId);
          if (currentEvents.length) {
            setDocument((current) => current?.session.id === currentSessionId
              ? { ...current, liveEvents: [...current.liveEvents, ...currentEvents] }
              : current);
          }
        }
      }
      const completedProjects = new Map<string, string>();
      for (const envelope of batch) {
        if (envelope.event.type === "run.completed" || envelope.event.type === "run.aborted" || envelope.event.type === "run.failed") {
          completedProjects.set(envelope.projectId, envelope.event.sessionId);
        }
      }
      for (const [projectId, sessionId] of completedProjects) scheduleRefresh(projectId, sessionId);
    };

    const scheduleRefresh = (projectId: string, sessionId: string): void => {
      const existing = refreshTimers.get(projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        refreshTimers.delete(projectId);
        void window.biny.refreshProject(projectId).then(async (snapshot) => {
          if (projectRef.current !== projectId) return;
          mergeWorkspaceProject(snapshot);
          if (selectedRef.current === sessionId) {
            const refreshedDocument = await window.biny.openSession(projectId, sessionId);
            if (projectRef.current === projectId && selectedRef.current === sessionId) setDocument(refreshedDocument);
          }
        }).catch((error) => setToast(errorMessage(error)));
      }, 260);
      refreshTimers.set(projectId, timer);
    };

    const unsubscribe = window.biny.onAgentEvent((envelope) => {
      eventQueueRef.current.push(envelope);
      eventFrameRef.current ??= window.requestAnimationFrame(flushEvents);
    });
    return () => {
      unsubscribe();
      if (eventFrameRef.current !== undefined) window.cancelAnimationFrame(eventFrameRef.current);
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
    };
  }, [mergeWorkspaceProject]);

  useEffect(() => window.biny.onMenuAction((action) => menuActionRef.current(action)), []);

  const openProject = useCallback(async (): Promise<void> => {
    setUnavailableFeature(undefined);
    try {
      const snapshot = await window.biny.openProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
        if (snapshot.selectedSessionId) commitNavigation(pushNavigation(navigationRef.current, { projectId: snapshot.project.id, sessionId: snapshot.selectedSessionId }));
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation]);

  const createEmptyProject = useCallback(async (): Promise<void> => {
    setUnavailableFeature(undefined);
    try {
      const snapshot = await window.biny.createEmptyProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
        setFocusToken((value) => value + 1);
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const selectProject = useCallback(async (projectId: string): Promise<void> => {
    if (projectId === projectRef.current) {
      setUnavailableFeature(undefined);
      return;
    }
    setLoading(true);
    setDocument(undefined);
    try {
      const snapshot = await window.biny.selectProject(projectId);
      await adoptWorkspace(snapshot);
      if (snapshot.selectedSessionId) commitNavigation(pushNavigation(navigationRef.current, { projectId, sessionId: snapshot.selectedSessionId }));
    } catch (error) {
      setLoading(false);
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation]);

  const newTask = useCallback(async (): Promise<void> => {
    setUnavailableFeature(undefined);
    const projectId = projectRef.current;
    if (!projectId) {
      await openProject();
      return;
    }
    const target: DesktopNavigationTarget = { projectId, sessionId: undefined };
    const previousNavigation = navigationRef.current;
    try {
      await openNavigationTarget(target);
      commitNavigation(pushNavigation(previousNavigation, target));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget, openProject]);

  const navigateToSession = useCallback(async (projectId: string, sessionId: string): Promise<void> => {
    const previousNavigation = navigationRef.current;
    const target: DesktopNavigationTarget = { projectId, sessionId };
    commitNavigation(pushNavigation(previousNavigation, target));
    try {
      await openNavigationTarget(target);
    } catch (error) {
      commitNavigation(previousNavigation);
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget]);

  const navigateHistory = useCallback(async (direction: -1 | 1): Promise<void> => {
    const previousNavigation = navigationRef.current;
    const moved = moveNavigation(previousNavigation, direction);
    if (!moved.target) return;
    commitNavigation(moved.state);
    try {
      await openNavigationTarget(moved.target);
    } catch (error) {
      commitNavigation(previousNavigation);
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget]);

  useEffect(() => {
    menuActionRef.current = (action) => {
      if (action === "new-task") void newTask();
      if (action === "open-project") void openProject();
      if (action === "search") setSearchOpen(true);
      if (action === "settings") setSettingsOpen(true);
      if (action === "toggle-sidebar") setSidebarVisible((value) => !value);
      if (action === "focus-composer") setFocusToken((value) => value + 1);
    };
  }, [newTask, openProject]);

  const sendPrompt = useCallback(async (input: string, mode: AgentRunMode, attachments: DesktopAttachment[]): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const previousSessionId = selectedRef.current;
    const previousNavigation = navigationRef.current;
    const receipt = await window.biny.sendPrompt(projectId, selectedRef.current, input, mode, attachments);
    setSelectedSessionId(receipt.sessionId);
    if (receipt.sessionId !== previousSessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    if (!document || document.session.id !== receipt.sessionId) {
      const summary = workspace?.sessions.find((session) => session.id === receipt.sessionId) ?? syntheticSession(projectId, receipt.sessionId, input);
      setDocument({ session: summary, events: [], liveEvents: [] });
    }
    if (receipt.queued) setToast("补充要求已排入当前会话");
  }, [commitNavigation, document, workspace?.sessions]);

  const toggleProjectPinned = useCallback(async (projectId: string, pinned: boolean): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.setProjectPinned(projectId, pinned));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

  const renameProject = useCallback((projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) setRenameTarget({ kind: "project", projectId, title: project.name, sessionId: undefined });
  }, [projects]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    try {
      const bootstrap = await window.biny.removeProject(projectId);
      setProjects(bootstrap.projects);
      setWorkspace(bootstrap.workspace);
      setDocument(undefined);
      setSelectedSessionId(bootstrap.selectedSessionId);
      commitNavigation(createNavigationState());
      if (bootstrap.workspace && bootstrap.selectedSessionId) await openSession(bootstrap.workspace.project.id, bootstrap.selectedSessionId);
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openSession]);

  const switchModel = useCallback(async (alias: string, thinking: ThinkingSelection): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    const info = await window.biny.switchModel(projectId, alias, thinking);
    setWorkspace((current) => updateRuntimeInfo(current, info));
  }, []);

  const saveModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    mergeWorkspaceProject(await window.biny.saveModelConfiguration(projectId, configuration));
  }, [mergeWorkspaceProject]);

  const setPermissionMode = useCallback(async (mode: PermissionMode): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    mergeWorkspaceProject(await window.biny.setPermissionMode(projectId, mode));
  }, [mergeWorkspaceProject]);

  const saveAttachment = useCallback(async (file: File): Promise<DesktopAttachment> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MB。`);
    return await window.biny.saveAttachment(projectId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  }, []);

  const resolvePermission = useCallback(async (requestId: string, result: PermissionResult): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    await window.biny.resolvePermission(projectId, requestId, result);
  }, []);

  const turns = useMemo(() => document ? buildSessionTimeline(document.events, document.liveEvents) : [], [document]);
  const clearToast = useCallback(() => setToast(undefined), []);
  const sessionSummary = workspace?.sessions.find((session) => session.id === selectedSessionId) ?? document?.session;
  const activeSessionId = workspace?.runtime?.activeRun?.sessionId ?? workspace?.runtime?.pendingPermission?.sessionId;
  const selectedRunning = Boolean(activeSessionId && activeSessionId === selectedSessionId);
  const activeElsewhere = Boolean(activeSessionId && selectedSessionId && activeSessionId !== selectedSessionId);
  const composer = (
    <Composer
      activeElsewhere={activeElsewhere}
      focusToken={focusToken}
      models={workspace?.models ?? []}
      onOpenProject={() => void openProject()}
      onPermissionMode={setPermissionMode}
      onSaveAttachment={saveAttachment}
      onSend={sendPrompt}
      onStop={async () => { const projectId = projectRef.current; if (projectId) await window.biny.cancelRun(projectId); }}
      onSwitchModel={switchModel}
      permissionMode={workspace?.runtime?.permissionMode ?? "ask"}
      project={workspace?.project}
      running={selectedRunning}
      runtimeInfo={workspace?.runtime?.info}
      sessionId={selectedSessionId}
    />
  );

  return (
    <div className={`app-shell${sidebarVisible ? "" : " is-sidebar-hidden"}`}>
      <Sidebar
        activeProjectId={workspace?.project.id}
        canGoBack={canNavigateBack(navigation)}
        canGoForward={canNavigateForward(navigation)}
        onNavigateBack={() => void navigateHistory(-1)}
        onNavigateForward={() => void navigateHistory(1)}
        onToggleSidebar={() => setSidebarVisible(false)}
        onCreateEmptyProject={() => void createEmptyProject()}
        onOpenProject={() => void openProject()}
        onProjectPinned={(projectId, pinned) => void toggleProjectPinned(projectId, pinned)}
        onRemoveProject={(projectId) => void removeProject(projectId)}
        onRenameProject={renameProject}
        onRevealProject={(projectId) => { void window.biny.revealProject(projectId).catch((error) => setToast(errorMessage(error))); }}
        onSearch={() => setSearchOpen(true)}
        onSelectProject={(projectId) => void selectProject(projectId)}
        onSettings={() => setSettingsOpen(true)}
        onUnavailable={(feature) => setUnavailableFeature(feature)}
        onWidthChange={(width) => { setSidebarWidth(width); void window.biny.setSidebarWidth(width); }}
        projects={projects}
        sessions={workspace?.sessions ?? []}
        version={version}
        visible={sidebarVisible}
        width={sidebarWidth}
      />
      <Workspace
        canGoBack={canNavigateBack(navigation)}
        canGoForward={canNavigateForward(navigation)}
        loading={loading}
        onNavigateBack={() => void navigateHistory(-1)}
        onNavigateForward={() => void navigateHistory(1)}
        onOpenFile={(path) => { const projectId = projectRef.current; if (projectId) void window.biny.openWorkspaceFile(projectId, path).catch((error) => setToast(errorMessage(error))); }}
        onOpenProject={() => void openProject()}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefreshProject={() => { const projectId = projectRef.current; if (projectId) void window.biny.refreshProject(projectId).then(mergeWorkspaceProject).catch((error) => setToast(errorMessage(error))); }}
        onResolvePermission={resolvePermission}
        onRetry={(input) => void sendPrompt(input, "chat", []).catch((error) => setToast(errorMessage(error)))}
        onToggleSidebar={() => setSidebarVisible(true)}
        project={workspace?.project}
        projectId={workspace?.project.id}
        runtimeError={workspace?.runtimeError}
        sessionId={selectedSessionId}
        sessionTitle={sessionSummary?.title}
        sidebarVisible={sidebarVisible}
        turns={turns}
        unavailableFeature={unavailableFeature}
      >
        {composer}
      </Workspace>

      <SearchOverlay
        onClose={() => setSearchOpen(false)}
        onProject={(projectId) => void selectProject(projectId)}
        onSession={(sessionId) => { const projectId = projectRef.current; if (projectId) void navigateToSession(projectId, sessionId); }}
        open={searchOpen}
        projects={projects}
        sessions={workspace?.sessions ?? []}
      />
      <SettingsOverlay
        onClose={() => setSettingsOpen(false)}
        onCompact={async () => { const projectId = projectRef.current; if (projectId) await window.biny.compact(projectId); }}
        onOpenTerminal={async () => { const projectId = projectRef.current; if (projectId) await window.biny.openProjectTerminal(projectId); }}
        onPermissionMode={setPermissionMode}
        onRemoveProject={async () => { const projectId = projectRef.current; if (projectId) await removeProject(projectId); setSettingsOpen(false); }}
        onRevealProject={async () => { const projectId = projectRef.current; if (projectId) await window.biny.revealProject(projectId); }}
        onSaveModelConfiguration={saveModelConfiguration}
        onSwitchModel={switchModel}
        open={settingsOpen}
        version={version}
        workspace={workspace}
      />
      <RenameOverlay
        initialValue={renameTarget?.title ?? ""}
        title={renameTarget?.kind === "project" ? "重命名项目" : "重命名会话"}
        onClose={() => setRenameTarget(undefined)}
        onSave={async (title) => {
          if (!renameTarget) return;
          if (renameTarget.kind === "project") {
            mergeProjectSnapshot(await window.biny.renameProject(renameTarget.projectId, title));
          } else if (renameTarget.sessionId) {
            mergeWorkspaceProject(await window.biny.renameSession(renameTarget.projectId, renameTarget.sessionId, title));
            setDocument((current) => {
              if (!current || current.session.id !== renameTarget.sessionId) return current;
              return { events: current.events, liveEvents: current.liveEvents, session: { ...current.session, title } };
            });
          }
          setRenameTarget(undefined);
        }}
        open={Boolean(renameTarget)}
      />
      <Toast message={toast} onClose={clearToast} />
    </div>
  );
}

function applyEventsToWorkspace(workspace: DesktopWorkspaceSnapshot, events: AgentHostEvent[]): DesktopWorkspaceSnapshot {
  const sessions = [...workspace.sessions];
  let runtime = workspace.runtime ? { ...workspace.runtime, queuedRuns: [...workspace.runtime.queuedRuns] } : undefined;
  for (const event of events) {
    let session = sessions.find((candidate) => candidate.id === event.sessionId);
    if (!session && event.type === "message.user") {
      session = syntheticSession(workspace.project.id, event.sessionId, event.content);
      sessions.unshift(session);
    }
    if (session && event.type === "message.user") {
      session = { ...session, title: session.title === "新任务" ? titleFromInput(event.content) : session.title, firstUserMessage: session.firstUserMessage || event.content, status: "running", updatedAt: event.timestamp };
      replaceSession(sessions, session);
    }
    if (session && event.type === "run.started") {
      replaceSession(sessions, { ...session, status: "running", updatedAt: event.timestamp });
      if (runtime) {
        runtime = {
          ...runtime,
          activeRun: {
            sessionId: event.sessionId,
            runId: event.runId,
            messageId: event.messageId,
            input: event.input,
            mode: event.mode,
            status: "running",
            startedAt: event.timestamp
          },
          queuedRuns: runtime.queuedRuns.filter((run) => run.runId !== event.runId)
        };
      }
    }
    if (session && event.type === "permission.requested") {
      replaceSession(sessions, { ...session, status: "waiting_permission", updatedAt: event.timestamp });
      if (runtime) runtime = { ...runtime, pendingPermission: { sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, toolCallId: event.toolCallId, request: event.request } };
    }
    if (session && event.type === "permission.resolved") {
      replaceSession(sessions, { ...session, status: "running", updatedAt: event.timestamp });
      if (runtime?.pendingPermission?.requestId === event.requestId) runtime = { ...runtime, pendingPermission: undefined };
    }
    if (session && (event.type === "run.completed" || event.type === "run.aborted" || event.type === "run.failed")) {
      replaceSession(sessions, { ...session, status: event.type === "run.failed" ? "failed" : "completed", updatedAt: event.timestamp });
      if (runtime?.activeRun?.runId === event.runId) runtime = { ...runtime, activeRun: undefined, pendingPermission: undefined };
    }
  }
  return { ...workspace, sessions: sessions.sort(sessionSort), runtime };
}

function updateRuntimeInfo(workspace: DesktopWorkspaceSnapshot | undefined, info: ModelRuntimeInfo): DesktopWorkspaceSnapshot | undefined {
  if (!workspace?.runtime) return workspace;
  return {
    ...workspace,
    runtime: {
      ...workspace.runtime,
      info: {
        ...workspace.runtime.info,
        modelAlias: info.modelAlias,
        provider: info.provider,
        modelLabel: info.modelLabel,
        reasoningLabel: info.reasoningLabel,
        thinking: info.thinking
      }
    }
  };
}

function syntheticSession(projectId: string, sessionId: string, input: string): DesktopSessionSummary {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    projectId,
    fileName: `${sessionId}.jsonl`,
    title: titleFromInput(input),
    firstUserMessage: input,
    lastAssistantMessage: "",
    eventCount: 0,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    status: "running"
  };
}

function replaceSession(sessions: DesktopSessionSummary[], next: DesktopSessionSummary): void {
  const index = sessions.findIndex((session) => session.id === next.id);
  if (index >= 0) sessions[index] = next;
}

function sessionSort(left: DesktopSessionSummary, right: DesktopSessionSummary): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function mergeProject(projects: DesktopProject[], next: DesktopProject): DesktopProject[] {
  const index = projects.findIndex((project) => project.id === next.id);
  if (index < 0) return [next, ...projects];
  const copy = [...projects];
  copy[index] = next;
  return copy;
}

function titleFromInput(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 64) || "新任务";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
