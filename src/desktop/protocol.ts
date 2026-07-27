/**
 * 桌面端 IPC 协议。
 *
 * 主进程和渲染进程之间唯一的契约：`desktopIpc` 是通道名常量表，`DesktopApi` 是渲染层可调用
 * 的方法集合，其余是两端共享的数据形状。三处必须同步改动——这里加方法、preload 里加转发、
 * ipc.ts 里加 handler，少一处就是运行时报错。
 *
 * 通道名统一用 `desktop:<领域>:<动作>` 的形式，便于排查。
 */
import type { AgentRunMode } from "../agent/AgentSession.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import type { ModelApiBackend, ModelCompatibility, ModelProvider, ThinkingLevelMap, WebSearchConfig } from "../config/schema.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { AgentHostEvent, InteractiveRuntimeSnapshot } from "../runtime/agentEvents.js";
import type { SessionEvent } from "../session/recorder.js";

export const desktopIpc = {
  bootstrap: "desktop:bootstrap",
  openProject: "desktop:project:open",
  createEmptyProject: "desktop:project:create-empty",
  selectProject: "desktop:project:select",
  setProjectPinned: "desktop:project:pin",
  reorderProjects: "desktop:project:reorder",
  renameProject: "desktop:project:rename",
  removeProject: "desktop:project:remove",
  refreshProject: "desktop:project:refresh",
  revealProject: "desktop:project:reveal",
  openProjectTerminal: "desktop:project:terminal",
  startDraft: "desktop:session:draft",
  openSession: "desktop:session:open",
  renameSession: "desktop:session:rename",
  pinSession: "desktop:session:pin",
  duplicateSession: "desktop:session:duplicate",
  deleteSession: "desktop:session:delete",
  sessionMenu: "desktop:session:menu",
  sendPrompt: "desktop:agent:send",
  editPrompt: "desktop:agent:edit",
  cancelRun: "desktop:agent:cancel",
  runSlashCommand: "desktop:agent:slash",
  resolvePermission: "desktop:permission:resolve",
  setPermissionMode: "desktop:permission:mode",
  switchModel: "desktop:model:switch",
  saveModelConfiguration: "desktop:model:save-configuration",
  testModelConfiguration: "desktop:model:test-configuration",
  removeModelConfiguration: "desktop:model:remove-configuration",
  fetchModelCatalog: "desktop:model:fetch-catalog",
  startModelLogin: "desktop:model:login:start",
  completeModelLogin: "desktop:model:login:complete",
  cancelModelLogin: "desktop:model:login:cancel",
  compact: "desktop:agent:compact",
  webSearchSettings: "desktop:web-search:settings",
  saveWebSearchSettings: "desktop:web-search:save",
  openBrowser: "desktop:browser:open",
  cookieJarStatus: "desktop:browser:cookies:status",
  exportCookies: "desktop:browser:cookies:export",
  importCookies: "desktop:browser:cookies:import",
  clearCookies: "desktop:browser:cookies:clear",
  memoryOverview: "desktop:memory:overview",
  saveMemorySettings: "desktop:memory:save-settings",
  searchMemory: "desktop:memory:search",
  addMemoryEntry: "desktop:memory:add",
  deleteMemoryEntry: "desktop:memory:delete-entry",
  clearMemory: "desktop:memory:clear",
  compactMemory: "desktop:memory:compact",
  saveAttachment: "desktop:attachment:save",
  resolveDroppedFile: "desktop:attachment:resolve-path",
  listWorkspaceDirectory: "desktop:file:list-directory",
  readWorkspaceFile: "desktop:file:read",
  readInlineImage: "desktop:file:read-image",
  openWorkspaceFile: "desktop:file:open",
  openExternal: "desktop:external:open",
  setSidebarWidth: "desktop:ui:sidebar-width",
  setFilePanelWidth: "desktop:ui:file-panel-width",
  setThemePreference: "desktop:ui:theme",
  setFontPreference: "desktop:ui:font",
  createTerminal: "desktop:terminal:create",
  writeTerminal: "desktop:terminal:write",
  resizeTerminal: "desktop:terminal:resize",
  disposeTerminal: "desktop:terminal:dispose",
  terminalEvent: "desktop:terminal:event",
  event: "desktop:agent:event",
  menuAction: "desktop:menu:action"
} as const;

export type DesktopThemePreference = "system" | "light" | "dark";

/** 界面字体偏好。`family` 为 CSS 字体族名，"system" 表示跟随操作系统；`size` 为基准字号（px）。 */
export interface DesktopFontPreference {
  family: string;
  size: number;
}
export type DesktopSessionStatus = "idle" | "running" | "waiting_permission" | "incomplete" | "aborted" | "failed" | "completed";

/** 侧栏里的一个项目。`missing` 表示目录已不存在但记录仍保留，界面上标灰而不是直接消失。 */
export interface DesktopProject {
  id: string;
  path: string;
  name: string;
  branch?: string;
  dirty: boolean;
  missing: boolean;
  pinned: boolean;
  addedAt: string;
  lastOpenedAt: string;
}

export interface DesktopSessionSummary {
  id: string;
  projectId: string;
  fileName: string;
  title: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  status: DesktopSessionStatus;
}

/**
 * 打开一个会话时返回的完整内容。
 * `events` 是已落盘的历史事件，`liveEvents` 是当前这轮还在进行中的实时事件，
 * 渲染层需要把两段拼起来展示（历史在前、实时在后）。
 */
export interface DesktopSessionDocument {
  session: DesktopSessionSummary;
  events: SessionEvent[];
  liveEvents: AgentHostEvent[];
}

export interface DesktopWorkspaceSnapshot {
  project: DesktopProject;
  sessions: DesktopSessionSummary[];
  selectedSessionId?: string;
  runtime?: InteractiveRuntimeSnapshot;
  runtimeError?: string;
  requiresModelConfiguration: boolean;
  models: ModelChoice[];
  connections: DesktopModelConnection[];
}

/** 渲染进程启动时一次性取回的初始状态，之后的变化都通过事件推送。 */
export interface DesktopBootstrap {
  version: string;
  platform: NodeJS.Platform;
  projects: DesktopProject[];
  activeProjectId?: string;
  selectedSessionId?: string;
  workspace?: DesktopWorkspaceSnapshot;
  sidebarWidth: number;
  filePanelWidth: number;
  themePreference: DesktopThemePreference;
  fontPreference: DesktopFontPreference;
}

/**
 * 发送提示后的回执。`queued` 为真表示这一轮被排进了运行队列（当前还有任务在跑），
 * 界面据此显示排队状态而不是立即进入运行中。
 */
export interface DesktopRunReceipt {
  sessionId: string;
  runId: string;
  messageId: string;
  queued: boolean;
}

/** 事件推送信封。带上 projectId 是因为所有项目共用同一条事件通道，渲染层要自己过滤。 */
export interface DesktopAgentEventEnvelope {
  projectId: string;
  event: AgentHostEvent;
}

export interface DesktopAttachment {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface DesktopWorkspaceFilePreview {
  path: string;
  content?: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}

export interface DesktopWorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface DesktopWorkspaceDirectory {
  path: string;
  entries: DesktopWorkspaceDirectoryEntry[];
}

export interface DesktopModelConfigurationInput {
  alias: string;
  displayName: string;
  providerAlias: string;
  providerType: ModelProvider;
  protocol?: "anthropic" | "openai-compatible";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  requiresApiKey?: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  apiBackend?: ModelApiBackend;
  thinkingLevelMap?: ThinkingLevelMap;
  compatibility?: ModelCompatibility;
  /**
   * Whether this configuration should also become the active default model.
   * Connecting a provider opts in; enabling an extra model, rotating a key or
   * editing a base URL must leave the current default alone.
   */
  makeDefault?: boolean;
}

/**
 * Credential and endpoint state for one configured provider alias. The renderer
 * needs this to prefill the real saved base URL, to tell "key set" from "key
 * missing", and to decide whether a connection is OAuth-backed (and expired).
 * Secrets themselves are never sent across the bridge — only their presence.
 */
export interface DesktopModelConnection {
  providerAlias: string;
  providerType: ModelProvider;
  protocol?: "anthropic" | "openai-compatible";
  baseUrl?: string;
  requiresApiKey: boolean;
  hasCredential: boolean;
  credentialSource?: "keychain" | "config" | "env";
  apiKeyEnv?: string;
  authMode?: "api-key" | "oauth-bearer";
  oauthProvider?: DesktopModelLoginProvider;
  /** Epoch millis; present only for OAuth-backed connections. */
  oauthExpiresAt?: number;
}

export interface DesktopModelCatalogResult {
  providerAlias: string;
  /** `fetched` means the provider answered; `fallback` means we kept what we had. */
  source: "fetched" | "fallback";
  fetchedAt: string;
  models: ModelCatalogEntry[];
}

export type DesktopModelLoginProvider = "claude-code" | "openai-codex";
export type DesktopModelLoginMethod = "paste-code" | "browser-callback";

export interface DesktopModelLoginStartResult {
  authRequestId: string;
  stateHint: string;
  method: DesktopModelLoginMethod;
}

export interface DesktopModelConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export type DesktopWebSearchProvider = WebSearchConfig["provider"];

/**
 * 联网搜索设置的渲染端视图。密钥本身不过桥：`hasApiKey` 只表示 config 中
 * 是否已保存密钥，`envKeyDetected` 表示生效的环境变量当前是否可用。
 */
export interface DesktopWebSearchSettings {
  enabled: boolean;
  provider: DesktopWebSearchProvider;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
  hasApiKey: boolean;
  envKeyName?: string;
  envKeyDetected: boolean;
}

export interface DesktopWebSearchSettingsInput {
  enabled: boolean;
  provider: DesktopWebSearchProvider;
  /** undefined 保留已存密钥；空字符串表示清除。 */
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxResults: number;
}

/**
 * 内嵌浏览器 cookie 的概览。cookie 值本身不过桥，只报数量和域名 —— 它们等同于登录凭据，
 * 渲染层也没有需要读到明文的场景。
 */
export interface DesktopCookieJarStatus {
  total: number;
  /** 按 cookie 数量排序的前几个域名，用于展示「当前登录了哪些站点」。 */
  domains: Array<{ domain: string; count: number }>;
  /** 共享 jar 文件的最后写入时间；从未同步过时为 undefined。 */
  updatedAt?: string;
}

/** 记忆设置的渲染端视图；与 `context.memory` 配置一一对应。 */
export interface DesktopMemorySettings {
  enabled: boolean;
  autoRemember: boolean;
  maxRecalled: number;
  /** 记忆抽取/整理的专用模型别名；undefined 表示跟随会话模型。 */
  model?: string;
}

export interface DesktopMemoryEntry {
  topic: string;
  /** 条目在话题文件内的小节序号，删除时用它定位。 */
  index: number;
  title: string;
  date?: string;
  summary: string;
}

export interface DesktopMemoryOverview {
  settings: DesktopMemorySettings;
  totalEntries: number;
  topics: Array<{ topic: string; entries: number }>;
  entries: DesktopMemoryEntry[];
}

export interface DesktopMemorySearchMatch {
  topic: string;
  path: string;
  excerpt: string;
  score: number;
}

export interface DesktopMemoryCompactionResult {
  topic: string;
  before: number;
  after: number;
  error?: string;
}

export interface DesktopSlashCommand {
  name: string;
  description: string;
  /** 需要参数的命令：从菜单选中时补进输入框让用户接着写，而不是直接执行。 */
  requiresArgs?: boolean;
}

/** 桌面端输入框支持的斜杠命令；执行走 runSlashCommand IPC。 */
export const DESKTOP_SLASH_COMMANDS: DesktopSlashCommand[] = [
  { name: "/status", description: "查看模型、权限与扩展状态" },
  { name: "/context", description: "查看已加载上下文与预算" },
  { name: "/usage", description: "查看 token 用量与成本" },
  { name: "/mcp", description: "查看 MCP；可输入 reconnect <server> 重连" },
  { name: "/skills", description: "查看可用技能" },
  { name: "/plugins", description: "查看已加载插件" },
  { name: "/memory", description: "查看持久记忆；可加 show/add/forget/search/compact 参数" },
  { name: "/subagent", description: "派发子代理任务；可加 start / status / cancel <task-id> / agents", requiresArgs: true },
  { name: "/review", description: "用只读子代理评审当前改动" }
];

export interface DesktopSlashResult {
  command: string;
  title: string;
  content: string;
}

export type DesktopMenuAction = "new-task" | "open-project" | "search" | "settings" | "toggle-sidebar" | "focus-composer";
export type DesktopSessionMenuAction = "rename" | "pin" | "unpin" | "duplicate" | "delete";

/** 内嵌终端创建结果。`replay` 是复用已有终端时回放的最近输出。 */
export interface DesktopTerminalHandle {
  terminalId: string;
  replay: string;
}

export type DesktopTerminalEvent =
  | { terminalId: string; type: "data"; data: string }
  | { terminalId: string; type: "exit"; exitCode: number };

/**
 * 渲染进程可用的全部主进程能力，运行时挂在 `window.biny` 上。
 *
 * 大部分方法返回更新后的 `DesktopWorkspaceSnapshot`，渲染层直接整体替换状态即可，
 * 不需要自己推算改动结果。`on*` 系列返回取消订阅函数。
 */
export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  openProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  createEmptyProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  selectProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot>;
  reorderProjects(projectIds: string[]): Promise<DesktopProject[]>;
  renameProject(projectId: string, name: string): Promise<DesktopWorkspaceSnapshot>;
  removeProject(projectId: string): Promise<DesktopBootstrap>;
  refreshProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  revealProject(projectId: string): Promise<void>;
  openProjectTerminal(projectId: string): Promise<void>;
  startDraft(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  openSession(projectId: string, sessionId: string): Promise<DesktopSessionDocument>;
  renameSession(projectId: string, sessionId: string, title: string): Promise<DesktopWorkspaceSnapshot>;
  pinSession(projectId: string, sessionId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot>;
  duplicateSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot>;
  deleteSession(projectId: string, sessionId: string): Promise<DesktopWorkspaceSnapshot>;
  showSessionMenu(projectId: string, sessionId: string, pinned: boolean): Promise<DesktopSessionMenuAction | undefined>;
  sendPrompt(projectId: string, sessionId: string | undefined, input: string, mode: AgentRunMode, attachments: DesktopAttachment[]): Promise<DesktopRunReceipt>;
  editPrompt(projectId: string, sessionId: string, userMessageIndex: number, input: string, mode: AgentRunMode, attachments: DesktopAttachment[]): Promise<DesktopRunReceipt>;
  cancelRun(projectId: string): Promise<void>;
  runSlashCommand(projectId: string, sessionId: string | undefined, command: string): Promise<DesktopSlashResult>;
  resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void>;
  setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot>;
  switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo>;
  saveModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot>;
  testModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  removeModelConfiguration(projectId: string, alias: string): Promise<DesktopWorkspaceSnapshot>;
  fetchModelCatalog(projectId: string, providerAlias: string): Promise<DesktopModelCatalogResult>;
  startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  completeModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopWorkspaceSnapshot>;
  cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  compact(projectId: string, hint?: string): Promise<string>;
  webSearchSettings(projectId: string): Promise<DesktopWebSearchSettings>;
  saveWebSearchSettings(projectId: string, input: DesktopWebSearchSettingsInput): Promise<DesktopWebSearchSettings>;
  /** 打开内嵌浏览器窗口；`url` 省略时打开首页。登录态由浏览器 partition 保存并同步给 agent 工具。 */
  openBrowser(url?: string): Promise<void>;
  cookieJarStatus(): Promise<DesktopCookieJarStatus>;
  exportCookies(): Promise<DesktopCookieJarStatus>;
  importCookies(): Promise<DesktopCookieJarStatus>;
  clearCookies(): Promise<DesktopCookieJarStatus>;
  memoryOverview(projectId: string): Promise<DesktopMemoryOverview>;
  saveMemorySettings(projectId: string, input: DesktopMemorySettings): Promise<DesktopMemoryOverview>;
  searchMemory(projectId: string, query: string): Promise<DesktopMemorySearchMatch[]>;
  addMemoryEntry(projectId: string, topic: string, note: string): Promise<DesktopMemoryOverview>;
  deleteMemoryEntry(projectId: string, topic: string, index: number): Promise<DesktopMemoryOverview>;
  clearMemory(projectId: string): Promise<DesktopMemoryOverview>;
  compactMemory(projectId: string): Promise<DesktopMemoryCompactionResult[]>;
  saveAttachment(projectId: string, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment>;
  resolveDroppedFile(file: File): string;
  listWorkspaceDirectory(projectId: string, relativePath: string): Promise<DesktopWorkspaceDirectory>;
  readWorkspaceFile(projectId: string, relativePath: string): Promise<DesktopWorkspaceFilePreview>;
  /** 读取消息里引用的本地图片，返回 data URL；不是图片、太大或读不到时返回 undefined。 */
  readInlineImage(projectId: string, relativePath: string): Promise<string | undefined>;
  openWorkspaceFile(projectId: string, relativePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
  setFilePanelWidth(width: number): Promise<void>;
  setThemePreference(theme: DesktopThemePreference): Promise<DesktopThemePreference>;
  setFontPreference(font: DesktopFontPreference): Promise<DesktopFontPreference>;
  createTerminal(projectId: string, cols: number, rows: number): Promise<DesktopTerminalHandle>;
  writeTerminal(terminalId: string, data: string): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  disposeTerminal(terminalId: string): Promise<void>;
  onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): () => void;
  onAgentEvent(listener: (envelope: DesktopAgentEventEnvelope) => void): () => void;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
}
