import type { AgentRunMode } from "../agent/AgentSession.js";
import type { ModelProvider } from "../config/schema.js";
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
  resolvePermission: "desktop:permission:resolve",
  setPermissionMode: "desktop:permission:mode",
  switchModel: "desktop:model:switch",
  saveModelConfiguration: "desktop:model:save-configuration",
  testModelConfiguration: "desktop:model:test-configuration",
  removeModelConfiguration: "desktop:model:remove-configuration",
  startModelLogin: "desktop:model:login:start",
  completeModelLogin: "desktop:model:login:complete",
  cancelModelLogin: "desktop:model:login:cancel",
  compact: "desktop:agent:compact",
  saveAttachment: "desktop:attachment:save",
  resolveDroppedFile: "desktop:attachment:resolve-path",
  listWorkspaceDirectory: "desktop:file:list-directory",
  readWorkspaceFile: "desktop:file:read",
  openWorkspaceFile: "desktop:file:open",
  openExternal: "desktop:external:open",
  setSidebarWidth: "desktop:ui:sidebar-width",
  setFilePanelWidth: "desktop:ui:file-panel-width",
  event: "desktop:agent:event",
  menuAction: "desktop:menu:action"
} as const;

export type DesktopSessionStatus = "idle" | "running" | "waiting_permission" | "failed" | "completed";

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
}

export interface DesktopBootstrap {
  version: string;
  platform: NodeJS.Platform;
  projects: DesktopProject[];
  activeProjectId?: string;
  selectedSessionId?: string;
  workspace?: DesktopWorkspaceSnapshot;
  sidebarWidth: number;
  filePanelWidth: number;
}

export interface DesktopRunReceipt {
  sessionId: string;
  runId: string;
  messageId: string;
  queued: boolean;
}

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
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  supportsTools: boolean;
  supportsThinking: boolean;
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

export type DesktopMenuAction = "new-task" | "open-project" | "search" | "settings" | "toggle-sidebar" | "focus-composer";
export type DesktopSessionMenuAction = "rename" | "pin" | "unpin" | "duplicate" | "delete";

export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  openProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  createEmptyProject(): Promise<DesktopWorkspaceSnapshot | undefined>;
  selectProject(projectId: string): Promise<DesktopWorkspaceSnapshot>;
  setProjectPinned(projectId: string, pinned: boolean): Promise<DesktopWorkspaceSnapshot>;
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
  resolvePermission(projectId: string, requestId: string, result: PermissionResult): Promise<void>;
  setPermissionMode(projectId: string, mode: PermissionMode): Promise<DesktopWorkspaceSnapshot>;
  switchModel(projectId: string, alias: string, thinking: ThinkingSelection): Promise<ModelRuntimeInfo>;
  saveModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopWorkspaceSnapshot>;
  testModelConfiguration(projectId: string, configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  removeModelConfiguration(projectId: string, alias: string): Promise<DesktopWorkspaceSnapshot>;
  startModelLogin(projectId: string, provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  completeModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<DesktopWorkspaceSnapshot>;
  cancelModelLogin(projectId: string, provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
  compact(projectId: string, hint?: string): Promise<string>;
  saveAttachment(projectId: string, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment>;
  resolveDroppedFile(file: File): string;
  listWorkspaceDirectory(projectId: string, relativePath: string): Promise<DesktopWorkspaceDirectory>;
  readWorkspaceFile(projectId: string, relativePath: string): Promise<DesktopWorkspaceFilePreview>;
  openWorkspaceFile(projectId: string, relativePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
  setFilePanelWidth(width: number): Promise<void>;
  onAgentEvent(listener: (envelope: DesktopAgentEventEnvelope) => void): () => void;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
}
