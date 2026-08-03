/**
 * Desktop 渲染进程的装配根。
 *
 * 这里只保留跨区域的项目、会话、导航和浮层状态；运行时事件投影、设置命令、Inspector
 * 与 Composer 本地交互分别下沉到 `app/` 和对应组件。子组件通过回调表达意图，不直接持有
 * Agent、Session 或 Provider。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InteractiveAgentRunMode } from "../../../agent/AgentSession.js";
import type { ContextBudgetStatus } from "../../../agent/context/types.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import { activeRun, pendingPermission } from "../../../runtime/agentEvents.js";
import type {
  DesktopAttachment,
  DesktopFontPreference,
  DesktopMenuAction,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopSlashResult,
  DesktopThemePreference,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_FONT_PREFERENCE, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "../../sidebarSizing.js";
import {
  createNavigationState,
  pushNavigation,
  replaceNavigation,
  type DesktopNavigationState,
  type DesktopNavigationTarget
} from "./navigationHistory.js";
import { buildSessionTimeline, listChangedFiles, type TimelineTurn } from "./sessionTimeline.js";
import { desktopApiVersionMismatchMessage, errorMessage } from "./app/desktopApi.js";
import {
  applyProjectOrder,
  eventsBeforeUserMessage,
  lastReportedInputTokens,
  mergeProject,
  replaceProjectSessions,
  syntheticSession
} from "./app/desktopState.js";
import { useDesktopEventBridge } from "./app/useDesktopEventBridge.js";
import { useDesktopSettingsActions } from "./app/useDesktopSettingsActions.js";
import { Composer, type ContextUsage } from "./components/Composer.js";
import { DesktopShell } from "./components/DesktopShell.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace } from "./components/Workspace.js";
import { DesktopToast } from "./components/overlays/DesktopToast.js";
import { RenameOverlay } from "./components/overlays/RenameOverlay.js";
import { SearchOverlay } from "./components/overlays/SearchOverlay.js";
import { SlashResultOverlay } from "./components/overlays/SlashResultOverlay.js";
import { SettingsOverlay, type SettingsTab } from "./components/settings/SettingsOverlay.js";

interface RenameTarget {
  kind: "project" | "session";
  projectId: string;
  sessionId?: string;
  title: string;
}

export function App(): React.JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DesktopSessionSummary[]>([]);
  const [workspace, setWorkspace] = useState<DesktopWorkspaceSnapshot>();
  const [document, setDocument] = useState<DesktopSessionDocument>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  const [themePreference, setThemePreference] = useState<DesktopThemePreference>("system");
  const [fontPreference, setFontPreference] = useState<DesktopFontPreference>(DEFAULT_FONT_PREFERENCE);
  const [focusToken, setFocusToken] = useState(0);
  const [deletedUserMessages, setDeletedUserMessages] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTargetTab, setSettingsTargetTab] = useState<SettingsTab>();
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [slashResult, setSlashResult] = useState<DesktopSlashResult>();
  const [toast, setToast] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const navigationRef = useRef<DesktopNavigationState>(createNavigationState());
  const loadRequestRef = useRef(0);
  const menuActionRef = useRef<(action: DesktopMenuAction) => void>(() => undefined);
  const modelSetupWasRequiredRef = useRef(false);

  const openSettings = useCallback((targetTab?: SettingsTab): void => {
    setSettingsTargetTab(targetTab);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsTargetTab(undefined);
  }, []);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  useEffect(() => {
    const required = Boolean(workspace?.requiresModelConfiguration);
    if (required) {
      modelSetupWasRequiredRef.current = true;
      openSettings("模型");
    } else if (modelSetupWasRequiredRef.current) {
      modelSetupWasRequiredRef.current = false;
      closeSettings();
    }
  }, [closeSettings, openSettings, workspace?.requiresModelConfiguration]);

  const commitNavigation = useCallback((next: DesktopNavigationState): void => {
    navigationRef.current = next;
  }, []);

  const mergeWorkspaceProject = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    setWorkspace(snapshot);
  }, []);

  const mergeProjectSnapshot = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    if (projectRef.current === snapshot.project.id) setWorkspace(snapshot);
  }, []);

  const reportEventError = useCallback((error: unknown): void => {
    setToast(errorMessage(error));
  }, []);

  const {
    addMemoryEntry,
    cancelModelLogin,
    clearMemory,
    compactMemory,
    completeModelLogin,
    deleteMemoryEntry,
    fetchModelCatalog,
    loadCookieJarStatus,
    loadMemoryOverview,
    loadWebSearchSettings,
    openBrowser,
    removeModelConfiguration,
    saveMemorySettings,
    saveModelConfiguration,
    saveWebSearchSettings,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration
  } = useDesktopSettingsActions({
    mergeProjectSnapshot,
    mergeWorkspaceProject,
    projectIdRef: projectRef,
    setWorkspace
  });

  const openSession = useCallback(async (projectId: string, sessionId: string, showLoader = true): Promise<void> => {
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    setSelectedSessionId(sessionId);
    // 上下文用量属于某一个会话，换会话就作废，等新会话跑出 context.updated 再显示。
    setContextBudget(undefined);
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
      setSidebarSessions(bootstrap.sidebarSessions);
      setSidebarWidth(clampSidebarWidth(bootstrap.sidebarWidth));
      setFilePanelWidth(bootstrap.filePanelWidth ?? DEFAULT_FILE_PANEL_WIDTH);
      setThemePreference(bootstrap.themePreference ?? "system");
      setFontPreference(bootstrap.fontPreference ?? DEFAULT_FONT_PREFERENCE);
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

  useDesktopEventBridge({
    activeProjectIdRef: projectRef,
    selectedSessionIdRef: selectedRef,
    mergeProjectSnapshot,
    onError: reportEventError,
    setContextBudget,
    setDocument,
    setSidebarSessions,
    setWorkspace
  });

  useEffect(() => window.biny.onMenuAction((action) => menuActionRef.current(action)), []);

  const openProject = useCallback(async (): Promise<void> => {
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
    if (projectId === projectRef.current) return;
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

  const newTask = useCallback(async (targetProjectId = projectRef.current): Promise<void> => {
    const projectId = targetProjectId;
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

  const openSessionMenu = useCallback(async (session: DesktopSessionSummary): Promise<void> => {
    try {
      const action = await window.biny.showSessionMenu(session.projectId, session.id, session.pinned);
      if (!action) return;
      if (action === "rename") {
        setRenameTarget({ kind: "session", projectId: session.projectId, sessionId: session.id, title: session.title });
        return;
      }
      if (action === "pin" || action === "unpin") {
        mergeProjectSnapshot(await window.biny.pinSession(session.projectId, session.id, action === "pin"));
        return;
      }
      if (action === "duplicate") {
        const previousNavigation = navigationRef.current;
        let snapshot = await window.biny.duplicateSession(session.projectId, session.id);
        if (projectRef.current !== session.projectId) {
          snapshot = await window.biny.selectProject(session.projectId);
        }
        await adoptWorkspace(snapshot);
        if (snapshot.selectedSessionId) {
          commitNavigation(pushNavigation(previousNavigation, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
        return;
      }
      if (action !== "delete") return;
      const deletingSelectedSession = projectRef.current === session.projectId && selectedRef.current === session.id;
      const snapshot = await window.biny.deleteSession(session.projectId, session.id);
      if (projectRef.current === session.projectId) {
        await adoptWorkspace(snapshot);
        if (deletingSelectedSession) {
          commitNavigation(replaceNavigation(navigationRef.current, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
      } else {
        mergeProjectSnapshot(snapshot);
      }
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation, mergeProjectSnapshot]);

  useEffect(() => {
    menuActionRef.current = (action) => {
      if (action === "new-task") void newTask();
      if (action === "open-project") void openProject();
      if (action === "search") setSearchOpen(true);
      if (action === "settings") openSettings();
      if (action === "toggle-sidebar") setSidebarVisible((value) => !value);
      if (action === "focus-composer") setFocusToken((value) => value + 1);
    };
  }, [newTask, openProject, openSettings]);

  const sendPrompt = useCallback(async (input: string, mode: InteractiveAgentRunMode, attachments: DesktopAttachment[], delivery?: "steer" | "followUp"): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const previousSessionId = selectedRef.current;
    const previousNavigation = navigationRef.current;
    const receipt = await window.biny.sendPrompt(projectId, selectedRef.current, input, mode, attachments, delivery);
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
  }, [commitNavigation, document, workspace?.sessions]);

  const runSlashCommand = useCallback(async (command: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    setSlashResult(await window.biny.runSlashCommand(projectId, selectedRef.current, command));
  }, []);

  const editPrompt = useCallback(async (
    input: string,
    mode: InteractiveAgentRunMode,
    attachments: DesktopAttachment[],
    sessionId: string,
    userMessageIndex: number
  ): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (selectedRef.current !== sessionId) throw new Error("请回到原消息所在的会话后再提交编辑。");
    const previousNavigation = navigationRef.current;
    const previousDocument = document;
    const edit = window.biny.editPrompt;
    if (typeof edit !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const receipt = await edit(projectId, sessionId, userMessageIndex, input, mode, attachments);
    setSelectedSessionId(receipt.sessionId);
    if (receipt.sessionId !== sessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    const sourceSummary = workspace?.sessions.find((session) => session.id === sessionId) ?? previousDocument?.session;
    const summary = sourceSummary
      ? { ...sourceSummary, id: receipt.sessionId, fileName: `${receipt.sessionId}.jsonl`, status: "running" as const, updatedAt: new Date().toISOString() }
      : syntheticSession(projectId, receipt.sessionId, input);
    const prefixEvents = previousDocument?.session.id === sessionId
      ? eventsBeforeUserMessage(previousDocument.events, userMessageIndex)
      : [];
    setDocument({ session: summary, events: prefixEvents, liveEvents: [] });
  }, [commitNavigation, document, workspace?.sessions]);

  const editUserMessage = useCallback(async (input: string, userMessageIndex: number): Promise<void> => {
    const sessionId = selectedRef.current;
    if (!sessionId) {
      throw new Error("当前消息还没有可编辑的会话。");
    }
    await editPrompt(input, "chat", [], sessionId, userMessageIndex);
  }, [editPrompt]);

  const deleteUserMessage = useCallback((turnId: string): void => {
    const scope = `${projectRef.current ?? "none"}:${selectedRef.current ?? "draft"}`;
    const key = `${scope}:${turnId}`;
    setDeletedUserMessages((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setToast("已删除这条用户消息");
  }, []);

  const createBranch = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setToast("当前草稿还没有可创建的分支");
      return;
    }
    const previousNavigation = navigationRef.current;
    try {
      const snapshot = await window.biny.duplicateSession(projectId, sessionId);
      await adoptWorkspace(snapshot);
      if (snapshot.selectedSessionId) commitNavigation(pushNavigation(previousNavigation, { projectId, sessionId: snapshot.selectedSessionId }));
      setToast("已创建会话分支");
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation]);

  const rollbackFiles = useCallback((turn: TimelineTurn): void => {
    const files = listChangedFiles(turn);
    setToast(files.length ? "当前消息的文件变更没有安全快照，暂不自动回滚" : "当前消息没有可回滚的文件");
  }, []);

  useEffect(() => {
    window.document.documentElement.dataset.theme = themePreference;
  }, [themePreference]);

  const changeThemePreference = useCallback((theme: DesktopThemePreference): void => {
    setThemePreference(theme);
    void window.biny.setThemePreference(theme).catch(() => undefined);
  }, []);

  // 字号通过 --app-font-size 驱动样式表里的 --font-scale 等比缩放全部文字；
  // 自定义字体族插到默认字体栈前面，缺字时仍能落到系统 CJK 字体。
  useEffect(() => {
    const style = window.document.documentElement.style;
    style.setProperty("--app-font-size", String(fontPreference.size));
    if (fontPreference.family === SYSTEM_FONT_FAMILY) style.removeProperty("--font-sans");
    else style.setProperty("--font-sans", `"${fontPreference.family.replaceAll('"', "")}", var(--font-sans-stack)`);
  }, [fontPreference]);

  const changeFontPreference = useCallback((font: DesktopFontPreference): void => {
    setFontPreference(font);
    void window.biny.setFontPreference(font).catch(() => undefined);
  }, []);

  const toggleProjectPinned = useCallback(async (projectId: string, pinned: boolean): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.setProjectPinned(projectId, pinned));
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

  const reorderProjects = useCallback(async (projectIds: string[]): Promise<void> => {
    // Quiet optimistic reorder — this is a low-stakes UI preference, not a warnable action.
    setProjects((current) => applyProjectOrder(current, projectIds));
    try {
      setProjects(await window.biny.reorderProjects(projectIds));
    } catch {
      // Keep the optimistic order; persistence can catch up on the next successful reorder.
    }
  }, []);

  const renameProject = useCallback((projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) setRenameTarget({ kind: "project", projectId, title: project.name, sessionId: undefined });
  }, [projects]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    try {
      const bootstrap = await window.biny.removeProject(projectId);
      setProjects(bootstrap.projects);
      setSidebarSessions(bootstrap.sidebarSessions);
      setWorkspace(bootstrap.workspace);
      setDocument(undefined);
      setSelectedSessionId(bootstrap.selectedSessionId);
      commitNavigation(createNavigationState());
      if (bootstrap.workspace && bootstrap.selectedSessionId) await openSession(bootstrap.workspace.project.id, bootstrap.selectedSessionId);
    } catch (error) {
      setToast(errorMessage(error));
    }
  }, [commitNavigation, openSession]);

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

  const readWorkspaceFile = useCallback(async (path: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.readWorkspaceFile(projectId, path);
  }, []);

  const listWorkspaceDirectory = useCallback(async (path: string): Promise<DesktopWorkspaceDirectory> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.listWorkspaceDirectory(projectId, path);
  }, []);

  const openWorkspaceFile = useCallback((path: string): void => {
    const projectId = projectRef.current;
    if (!projectId) return;
    void window.biny.openWorkspaceFile(projectId, path).catch((error) => setToast(errorMessage(error)));
  }, []);

  const turns = useMemo(() => document ? buildSessionTimeline(document.events, document.liveEvents) : [], [document]);
  const messageScope = `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`;
  const visibleTurns = useMemo(() => turns
    .map((turn) => deletedUserMessages.has(`${messageScope}:${turn.id}`) ? { ...turn, user: "" } : turn)
    .filter((turn) => turn.user || turn.assistant || turn.tools.length || turn.error), [deletedUserMessages, messageScope, turns]);
  // 上下文用量：优先用运行时刚上报的实时值；重开会话或刚启动时运行时还没跑过一轮，
  // 就退回会话里最后一次 provider 报告的输入 token 数——和运行时的 usedTokens 是同一个口径。
  const contextUsage = useMemo<ContextUsage | undefined>(() => {
    const info = workspace?.runtime?.info;
    const models = workspace?.models ?? [];
    const selectedModel = models.find((model) => model.alias === info?.modelAlias) ?? models[0];
    const maxTokens = contextBudget?.maxTokens ?? info?.maxInputTokens ?? selectedModel?.inputBudgetTokens;
    const usedTokens = contextBudget?.usedTokens ?? lastReportedInputTokens(document);
    if (!maxTokens || !usedTokens) return undefined;
    return { usedTokens, maxTokens };
  }, [contextBudget, document, workspace?.models, workspace?.runtime?.info]);
  const clearToast = useCallback(() => setToast(undefined), []);
  const sessionSummary = workspace?.sessions.find((session) => session.id === selectedSessionId) ?? document?.session;
  const activeSessionId = activeRun(workspace?.runtime)?.sessionId ?? pendingPermission(workspace?.runtime)?.sessionId;
  const selectedRunning = Boolean(activeSessionId && activeSessionId === selectedSessionId);
  const activeElsewhere = Boolean(activeSessionId && selectedSessionId && activeSessionId !== selectedSessionId);
  const composer = (
    <Composer
      activeElsewhere={activeElsewhere}
      contextUsage={contextUsage}
      focusToken={focusToken}
      modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
      models={workspace?.models ?? []}
      onPermissionMode={setPermissionMode}
      onConfigureModels={() => openSettings("模型")}
      onSaveAttachment={saveAttachment}
      onSend={sendPrompt}
      onSlashCommand={runSlashCommand}
      onStop={async () => { const projectId = projectRef.current; if (projectId) await window.biny.cancelRun(projectId); }}
      onSwitchModel={switchModel}
      permissionMode={workspace?.runtime?.permissionMode ?? "ask"}
      project={workspace?.project}
      running={selectedRunning}
      runtimeInfo={workspace?.runtime?.info}
    />
  );

  return (
    <DesktopShell
      overlays={(
        <>
          <SearchOverlay
            onClose={() => setSearchOpen(false)}
            onProject={(projectId) => void selectProject(projectId)}
            onSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
            open={searchOpen}
            projects={projects}
            sessions={sidebarSessions}
          />
          <SettingsOverlay
            modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
            onAddMemoryEntry={addMemoryEntry}
            onCancelModelLogin={cancelModelLogin}
            onClearCookies={async () => await window.biny.clearCookies()}
            onClearMemory={clearMemory}
            onClose={closeSettings}
            onCompactMemory={compactMemory}
            onCompleteModelLogin={completeModelLogin}
            onDeleteMemoryEntry={deleteMemoryEntry}
            onExportCookies={async () => await window.biny.exportCookies()}
            onFetchModelCatalog={fetchModelCatalog}
            onFontPreference={changeFontPreference}
            onImportCookies={async () => await window.biny.importCookies()}
            onLoadCookieJarStatus={loadCookieJarStatus}
            onLoadMemoryOverview={loadMemoryOverview}
            onLoadWebSearchSettings={loadWebSearchSettings}
            onOpenBrowser={openBrowser}
            onOpenExternal={async (url) => await window.biny.openExternal(url)}
            onRemoveModelConfiguration={removeModelConfiguration}
            onSaveMemorySettings={saveMemorySettings}
            onSaveModelConfiguration={saveModelConfiguration}
            onSaveWebSearchSettings={saveWebSearchSettings}
            onSearchMemory={searchMemory}
            onSkipModelSetup={closeSettings}
            onStartModelLogin={startModelLogin}
            onSwitchModel={switchModel}
            onTestModelConfiguration={testModelConfiguration}
            onThemePreference={changeThemePreference}
            open={settingsOpen}
            targetTab={settingsTargetTab}
            themePreference={themePreference}
            fontPreference={fontPreference}
            version={version}
            workspace={workspace}
          />
          <RenameOverlay
            initialValue={renameTarget?.title ?? ""}
            onClose={() => setRenameTarget(undefined)}
            onSave={async (title) => {
              if (!renameTarget) return;
              if (renameTarget.kind === "project") {
                mergeProjectSnapshot(await window.biny.renameProject(renameTarget.projectId, title));
              } else if (renameTarget.sessionId) {
                mergeProjectSnapshot(await window.biny.renameSession(renameTarget.projectId, renameTarget.sessionId, title));
                setDocument((current) => {
                  if (!current || current.session.id !== renameTarget.sessionId) return current;
                  return { events: current.events, liveEvents: current.liveEvents, session: { ...current.session, title } };
                });
              }
              setRenameTarget(undefined);
            }}
            open={Boolean(renameTarget)}
            title={renameTarget?.kind === "project" ? "重命名项目" : "重命名会话"}
          />
          <SlashResultOverlay onClose={() => setSlashResult(undefined)} result={slashResult} />
          <DesktopToast message={toast} onClose={clearToast} />
        </>
      )}
      sidebarVisible={sidebarVisible}
      sidebarWidth={sidebarWidth}
      sideNav={(
        <Sidebar
          activeProjectId={workspace?.project.id}
          onCreateEmptyProject={() => void createEmptyProject()}
          onNewTask={(projectId) => void newTask(projectId)}
          onOpenProject={() => void openProject()}
          onOpenTerminalProject={(projectId) => { void window.biny.openProjectTerminal(projectId).catch((error) => setToast(errorMessage(error))); }}
          onProjectPinned={(projectId, pinned) => void toggleProjectPinned(projectId, pinned)}
          onRefreshProject={(projectId) => { void window.biny.refreshProject(projectId).then(mergeProjectSnapshot).catch((error) => setToast(errorMessage(error))); }}
          onRemoveProject={(projectId) => void removeProject(projectId)}
          onRenameProject={renameProject}
          onReorderProjects={(projectIds) => void reorderProjects(projectIds)}
          onRevealProject={(projectId) => { void window.biny.revealProject(projectId).catch((error) => setToast(errorMessage(error))); }}
          onSearch={() => setSearchOpen(true)}
          onSelectProject={(projectId) => void selectProject(projectId)}
          onSelectSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
          onSessionMenu={(session) => void openSessionMenu(session)}
          onSettings={() => openSettings()}
          onVisibleChange={setSidebarVisible}
          onWidthChange={setSidebarWidth}
          onWidthCommit={(width) => { void window.biny.setSidebarWidth(width); }}
          projects={projects}
          selectedSessionId={selectedSessionId}
          sessions={sidebarSessions}
          visible={sidebarVisible}
          version={version}
          width={sidebarWidth}
        />
      )}
      theme={themePreference}
    >
      <Workspace
        filePanelResizing={filePanelResizing}
        filePanelWidth={filePanelWidth}
        loading={loading}
        onCreateBranch={() => { void createBranch(); }}
        onDeleteUserMessage={deleteUserMessage}
        onEditUserMessage={editUserMessage}
        onFilePanelResizeEnd={(width) => {
          setFilePanelResizing(false);
          void window.biny.setFilePanelWidth(width);
        }}
        onFilePanelResizeStart={() => setFilePanelResizing(true)}
        onFilePanelWidthChange={setFilePanelWidth}
        onOpenFile={openWorkspaceFile}
        onOpenExternal={(url) => void window.biny.openExternal(url).catch((error) => setToast(errorMessage(error)))}
        onOpenProject={() => void openProject()}
        onListDirectory={listWorkspaceDirectory}
        onReadFile={readWorkspaceFile}
        onResolvePermission={resolvePermission}
        onRollbackFiles={rollbackFiles}
        onRetry={(input) => void sendPrompt(input, "chat", []).catch((error) => setToast(errorMessage(error)))}
        project={workspace?.project}
        projectId={workspace?.project.id}
        runtimeError={workspace?.runtimeError}
        sessionId={selectedSessionId}
        sessionTitle={sessionSummary?.title}
        turns={visibleTurns}
      >
        {composer}
      </Workspace>
    </DesktopShell>
  );
}
