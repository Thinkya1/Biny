/**
 * 渲染进程根组件。
 *
 * 持有全部界面状态（项目、会话、时间线、浮层、布局尺寸），订阅主进程事件流并把状态分发给
 * Sidebar / Workspace / Composer / Overlays。所有 IPC 调用都集中在这里，子组件只通过回调
 * 表达意图。
 *
 * 事件通道是所有项目共用的，因此处理事件时必须先按 `projectId` 过滤，否则后台项目的输出会
 * 串到当前界面上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRunMode } from "../../../agent/AgentSession.js";
import type { ContextBudgetStatus, ContextStatus } from "../../../agent/context/types.js";
import type { ModelRuntimeInfo, ThinkingSelection } from "../../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../../permission/PermissionManager.js";
import type { AgentHostEvent } from "../../../runtime/agentEvents.js";
import type { SessionEvent } from "../../../session/recorder.js";
import { publicUserMessage } from "../../../session/publicMessage.js";
import type {
  DesktopAgentEventEnvelope,
  DesktopAttachment,
  DesktopFontPreference,
  DesktopMemorySettings,
  DesktopMenuAction,
  DesktopModelConfigurationInput,
  DesktopModelLoginProvider,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionSummary,
  DesktopSlashResult,
  DesktopThemePreference,
  DesktopWebSearchSettingsInput,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_FONT_PREFERENCE, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";
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
import { buildSessionTimeline, listChangedFiles, type TimelineTurn } from "./sessionTimeline.js";
import { Composer, type ContextUsage } from "./components/Composer.js";
import { NavigationControls } from "./components/NavigationControls.js";
import { FeatureUnavailableOverlay, RenameOverlay, SearchOverlay, SettingsOverlay, SlashResultOverlay, Toast } from "./components/Overlays.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace } from "./components/Workspace.js";

const desktopApiVersionMismatchMessage = "桌面端资源版本不一致，请完全退出 Biny 后重新启动。";

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
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  const [themePreference, setThemePreference] = useState<DesktopThemePreference>("system");
  const [fontPreference, setFontPreference] = useState<DesktopFontPreference>(DEFAULT_FONT_PREFERENCE);
  const [focusToken, setFocusToken] = useState(0);
  const [deletedUserMessages, setDeletedUserMessages] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unavailableFeature, setUnavailableFeature] = useState<string>();
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [slashResult, setSlashResult] = useState<DesktopSlashResult>();
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
  const modelSetupWasRequiredRef = useRef(false);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  useEffect(() => {
    const required = Boolean(workspace?.requiresModelConfiguration);
    if (required) {
      modelSetupWasRequiredRef.current = true;
      setSettingsOpen(true);
    } else if (modelSetupWasRequiredRef.current) {
      modelSetupWasRequiredRef.current = false;
      setSettingsOpen(false);
    }
  }, [workspace?.requiresModelConfiguration]);

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
      setSidebarWidth(bootstrap.sidebarWidth);
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

  // 事件流处理：事件先入队，按帧批量 flush。流式输出的事件非常密集，逐条 setState 会让界面卡顿。
  useEffect(() => {
    const refreshTimers = refreshTimersRef.current;
    const flushEvents = (): void => {
      eventFrameRef.current = undefined;
      const batch = eventQueueRef.current.splice(0);
      if (!batch.length) return;
      // 用 ref 而不是闭包里的 state：这个回调只注册一次，闭包里的值会是旧的。
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
            // 上下文用量只认最后一条：一轮里会多次上报，界面只需要最新值。
            const contextEvents = currentEvents.filter(hasContextStatus);
            const latestContext = contextEvents[contextEvents.length - 1];
            if (latestContext) setContextBudget(latestContext.context.budget);
          }
        }
      }
      // 终态事件要触发一次项目刷新（分支、脏状态、会话摘要都可能变），这里对整批事件都处理，
      // 包括非当前项目的：后台项目跑完了，侧栏也该更新。
      const completedProjects = new Map<string, string>();
      for (const envelope of batch) {
        if (envelope.event.type === "run.completed" || envelope.event.type === "run.incomplete" || envelope.event.type === "run.aborted" || envelope.event.type === "run.failed") {
          completedProjects.set(envelope.projectId, envelope.event.sessionId);
        }
      }
      for (const [projectId, sessionId] of completedProjects) scheduleRefresh(projectId, sessionId);
    };

    /** 按项目防抖刷新：一轮结束往往连着来几个事件，没必要各刷一次。 */
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

  const runSlashCommand = useCallback(async (command: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    setSlashResult(await window.biny.runSlashCommand(projectId, selectedRef.current, command));
  }, []);

  const editPrompt = useCallback(async (
    input: string,
    mode: AgentRunMode,
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
    // 切模型这一步可能刚刚把运行时创建出来，而界面手上的快照里还没有 runtime 字段，
    // 此时 updateRuntimeInfo 无处可写，界面会继续显示旧模型，直到别的操作（例如改权限模式）
    // 带回完整快照——看起来就像「一改权限模型就变了」。所以这里补一次完整刷新。
    mergeProjectSnapshot(await window.biny.refreshProject(projectId));
  }, [mergeProjectSnapshot]);

  const saveModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    mergeWorkspaceProject(await window.biny.saveModelConfiguration(projectId, configuration));
  }, [mergeWorkspaceProject]);

  const testModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.testModelConfiguration(projectId, configuration);
  }, []);

  const removeModelConfiguration = useCallback(async (alias: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    mergeWorkspaceProject(await window.biny.removeModelConfiguration(projectId, alias));
  }, [mergeWorkspaceProject]);

  const loadWebSearchSettings = useCallback(async () => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const webSearchSettings = window.biny.webSearchSettings;
    if (typeof webSearchSettings !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await webSearchSettings(projectId);
  }, []);

  const saveWebSearchSettings = useCallback(async (input: DesktopWebSearchSettingsInput) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.saveWebSearchSettings(projectId, input);
  }, []);

  const loadMemoryOverview = useCallback(async () => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const memoryOverview = window.biny.memoryOverview;
    if (typeof memoryOverview !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryOverview(projectId);
  }, []);

  const saveMemorySettings = useCallback(async (input: DesktopMemorySettings) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.saveMemorySettings(projectId, input);
  }, []);

  const searchMemory = useCallback(async (query: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.searchMemory(projectId, query);
  }, []);

  const addMemoryEntry = useCallback(async (topic: string, note: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.addMemoryEntry(projectId, topic, note);
  }, []);

  const deleteMemoryEntry = useCallback(async (topic: string, index: number) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.deleteMemoryEntry(projectId, topic, index);
  }, []);

  const clearMemory = useCallback(async () => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.clearMemory(projectId);
  }, []);

  const compactMemory = useCallback(async () => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    return await window.biny.compactMemory(projectId);
  }, []);

  const fetchModelCatalog = useCallback(async (providerAlias: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const fetchCatalog = window.biny.fetchModelCatalog;
    if (typeof fetchCatalog !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await fetchCatalog(projectId, providerAlias);
  }, []);

  const startModelLogin = useCallback(async (provider: DesktopModelLoginProvider) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const startLogin = window.biny.startModelLogin;
    if (typeof startLogin !== "function") {
      throw new Error(desktopApiVersionMismatchMessage);
    }
    return await startLogin(projectId, provider);
  }, []);

  const completeModelLogin = useCallback(async (provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    const completeLogin = window.biny.completeModelLogin;
    if (typeof completeLogin !== "function") {
      throw new Error(desktopApiVersionMismatchMessage);
    }
    mergeWorkspaceProject(await completeLogin(projectId, provider, authRequestId, pastedAuthorization));
  }, [mergeWorkspaceProject]);

  const cancelModelLogin = useCallback(async (provider: DesktopModelLoginProvider, authRequestId: string): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    const cancelLogin = window.biny.cancelModelLogin;
    if (typeof cancelLogin !== "function") return;
    await cancelLogin(projectId, provider, authRequestId);
  }, []);

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
    const maxTokens = contextBudget?.maxTokens ?? info?.maxInputTokens ?? selectedModel?.maxInputTokens;
    const usedTokens = contextBudget?.usedTokens ?? lastReportedInputTokens(document);
    if (!maxTokens || !usedTokens) return undefined;
    return { usedTokens, maxTokens };
  }, [contextBudget, document, workspace?.models, workspace?.runtime?.info]);
  const clearToast = useCallback(() => setToast(undefined), []);
  const sessionSummary = workspace?.sessions.find((session) => session.id === selectedSessionId) ?? document?.session;
  const activeSessionId = workspace?.runtime?.activeRun?.sessionId ?? workspace?.runtime?.pendingPermission?.sessionId;
  const selectedRunning = Boolean(activeSessionId && activeSessionId === selectedSessionId);
  const activeElsewhere = Boolean(activeSessionId && selectedSessionId && activeSessionId !== selectedSessionId);
  const composer = (
    <Composer
      activeElsewhere={activeElsewhere}
      contextUsage={contextUsage}
      focusToken={focusToken}
      modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
      models={workspace?.models ?? []}
      onOpenProject={() => void openProject()}
      onPermissionMode={setPermissionMode}
      onSaveAttachment={saveAttachment}
      onSend={sendPrompt}
      onSlashCommand={runSlashCommand}
      onStop={async () => { const projectId = projectRef.current; if (projectId) await window.biny.cancelRun(projectId); }}
      onSwitchModel={switchModel}
      onUnavailable={setUnavailableFeature}
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
        onNewTask={(projectId) => void newTask(projectId)}
        onCreateEmptyProject={() => void createEmptyProject()}
        onOpenProject={() => void openProject()}
        onProjectPinned={(projectId, pinned) => void toggleProjectPinned(projectId, pinned)}
        onRemoveProject={(projectId) => void removeProject(projectId)}
        onRenameProject={renameProject}
        onReorderProjects={(projectIds) => void reorderProjects(projectIds)}
        onRevealProject={(projectId) => { void window.biny.revealProject(projectId).catch((error) => setToast(errorMessage(error))); }}
        onOpenTerminalProject={(projectId) => { void window.biny.openProjectTerminal(projectId).catch((error) => setToast(errorMessage(error))); }}
        onSearch={() => setSearchOpen(true)}
        onSelectProject={(projectId) => void selectProject(projectId)}
        onSelectSession={(sessionId) => { const projectId = projectRef.current; if (projectId) void navigateToSession(projectId, sessionId); }}
        onSettings={() => setSettingsOpen(true)}
        onUnavailable={(feature) => setUnavailableFeature(feature)}
        onResizeEnd={() => setSidebarResizing(false)}
        onResizeStart={() => setSidebarResizing(true)}
        onWidthChange={(width) => { setSidebarWidth(width); void window.biny.setSidebarWidth(width); }}
        projects={projects}
        resizing={sidebarResizing}
        selectedSessionId={selectedSessionId}
        sessions={workspace?.sessions ?? []}
        visible={sidebarVisible}
        width={sidebarWidth}
      />
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
        onPanelNotice={setToast}
        onReadFile={readWorkspaceFile}
        onRefreshProject={() => { const projectId = projectRef.current; if (projectId) void window.biny.refreshProject(projectId).then(mergeWorkspaceProject).catch((error) => setToast(errorMessage(error))); }}
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
      <div
        className={`app-navigation${sidebarResizing ? " is-resizing" : ""}`}
        style={{ left: sidebarVisible ? Math.max(90, sidebarWidth - 93) : 90 }}
      >
        <NavigationControls
          canGoBack={canNavigateBack(navigation)}
          canGoForward={canNavigateForward(navigation)}
          onBack={() => void navigateHistory(-1)}
          onForward={() => void navigateHistory(1)}
          onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
          sidebarVisible={sidebarVisible}
        />
      </div>

      <SearchOverlay
        onClose={() => setSearchOpen(false)}
        onProject={(projectId) => void selectProject(projectId)}
        onSession={(sessionId) => { const projectId = projectRef.current; if (projectId) void navigateToSession(projectId, sessionId); }}
        open={searchOpen}
        projects={projects}
        sessions={workspace?.sessions ?? []}
      />
      <SettingsOverlay
        modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
        onClose={() => setSettingsOpen(false)}
        onSkipModelSetup={() => setSettingsOpen(false)}
        onLoadMemoryOverview={loadMemoryOverview}
        onSaveMemorySettings={saveMemorySettings}
        onSearchMemory={searchMemory}
        onAddMemoryEntry={addMemoryEntry}
        onDeleteMemoryEntry={deleteMemoryEntry}
        onClearMemory={clearMemory}
        onCompactMemory={compactMemory}
        onOpenExternal={async (url) => await window.biny.openExternal(url)}
        onRemoveModelConfiguration={removeModelConfiguration}
        onLoadWebSearchSettings={loadWebSearchSettings}
        onSaveWebSearchSettings={saveWebSearchSettings}
        onFetchModelCatalog={fetchModelCatalog}
        onStartModelLogin={startModelLogin}
        onCompleteModelLogin={completeModelLogin}
        onCancelModelLogin={cancelModelLogin}
        onSaveModelConfiguration={saveModelConfiguration}
        onTestModelConfiguration={testModelConfiguration}
        onSwitchModel={switchModel}
        onThemePreference={changeThemePreference}
        onFontPreference={changeFontPreference}
        open={settingsOpen}
        themePreference={themePreference}
        fontPreference={fontPreference}
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
      <FeatureUnavailableOverlay feature={unavailableFeature} onClose={() => setUnavailableFeature(undefined)} />
      <SlashResultOverlay onClose={() => setSlashResult(undefined)} result={slashResult} />
      <Toast message={toast} onClose={clearToast} />
    </div>
  );
}

function applyEventsToWorkspace(workspace: DesktopWorkspaceSnapshot, events: AgentHostEvent[]): DesktopWorkspaceSnapshot {
  const sessions = [...workspace.sessions];
  let runtime = workspace.runtime ? { ...workspace.runtime, queuedRuns: [...workspace.runtime.queuedRuns] } : undefined;
  for (const event of events) {
    const visibleInput = event.type === "message.user" ? publicUserMessage(event.content) : "";
    let session = sessions.find((candidate) => candidate.id === event.sessionId);
    if (!session && event.type === "message.user") {
      session = syntheticSession(workspace.project.id, event.sessionId, visibleInput);
      sessions.unshift(session);
    }
    if (session && event.type === "message.user") {
      session = { ...session, title: session.title === "新任务" ? titleFromInput(visibleInput) : session.title, firstUserMessage: session.firstUserMessage || visibleInput, status: "running", updatedAt: event.timestamp };
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
    if (session && (event.type === "run.completed" || event.type === "run.incomplete" || event.type === "run.aborted" || event.type === "run.failed")) {
      replaceSession(sessions, {
        ...session,
        status: event.type === "run.failed"
          ? "failed"
          : event.type === "run.incomplete"
            ? "incomplete"
            : event.type === "run.aborted" ? "aborted" : "completed",
        updatedAt: event.timestamp
      });
      if (runtime?.activeRun?.runId === event.runId) runtime = { ...runtime, activeRun: undefined, pendingPermission: undefined };
    }
  }
  return { ...workspace, sessions: sessions.sort(sessionSort), runtime };
}

/**
 * 会话里最后一次 provider 报告的输入 token 数。
 *
 * 运行时的 `usedTokens` 也是取自同一个 provider 用量，所以重开会话时用它回填不会算出另一套数字。
 * 内部尝试（`auditOnly`）不算进来：界面展示的是公开对话的上下文。
 */
function lastReportedInputTokens(document?: DesktopSessionDocument): number | undefined {
  if (!document) return undefined;
  let latest: number | undefined;
  for (const event of document.events) {
    if (event.type !== "assistant_message" || event.auditOnly) continue;
    if (event.usage?.inputTokens !== undefined) latest = event.usage.inputTokens;
  }
  return latest;
}

function hasContextStatus(event: AgentHostEvent): event is AgentHostEvent & { context: ContextStatus } {
  return event.type === "context.updated" || event.type === "compact.completed";
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

function applyProjectOrder(projects: DesktopProject[], projectIds: string[]): DesktopProject[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const ordered: DesktopProject[] = [];
  for (const projectId of projectIds) {
    const project = byId.get(projectId);
    if (!project || seen.has(projectId)) continue;
    ordered.push(project);
    seen.add(projectId);
  }
  for (const project of projects) {
    if (!seen.has(project.id)) ordered.push(project);
  }
  return ordered;
}

function titleFromInput(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 64) || "新任务";
}

function eventsBeforeUserMessage(events: SessionEvent[], userMessageIndex: number): SessionEvent[] {
  let seen = 0;
  for (const [index, event] of events.entries()) {
    if (event.type !== "user_message") continue;
    if (seen === userMessageIndex) return events.slice(0, index);
    seen += 1;
  }
  return events;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
