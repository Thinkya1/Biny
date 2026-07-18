import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAgentEventEnvelope, DesktopApi, DesktopMenuAction } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";

const api: DesktopApi = {
  bootstrap: async () => await ipcRenderer.invoke(desktopIpc.bootstrap),
  openProject: async () => await ipcRenderer.invoke(desktopIpc.openProject),
  createEmptyProject: async () => await ipcRenderer.invoke(desktopIpc.createEmptyProject),
  selectProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.selectProject, projectId),
  setProjectPinned: async (projectId, pinned) => await ipcRenderer.invoke(desktopIpc.setProjectPinned, projectId, pinned),
  renameProject: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.renameProject, projectId, name),
  removeProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.removeProject, projectId),
  refreshProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.refreshProject, projectId),
  revealProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.revealProject, projectId),
  openProjectTerminal: async (projectId) => await ipcRenderer.invoke(desktopIpc.openProjectTerminal, projectId),
  startDraft: async (projectId) => await ipcRenderer.invoke(desktopIpc.startDraft, projectId),
  openSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.openSession, projectId, sessionId),
  renameSession: async (projectId, sessionId, title) => await ipcRenderer.invoke(desktopIpc.renameSession, projectId, sessionId, title),
  pinSession: async (projectId, sessionId, pinned) => await ipcRenderer.invoke(desktopIpc.pinSession, projectId, sessionId, pinned),
  duplicateSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.duplicateSession, projectId, sessionId),
  deleteSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.deleteSession, projectId, sessionId),
  showSessionMenu: async (projectId, sessionId, pinned) => await ipcRenderer.invoke(desktopIpc.sessionMenu, projectId, sessionId, pinned),
  sendPrompt: async (projectId, sessionId, input, mode, attachments) => await ipcRenderer.invoke(desktopIpc.sendPrompt, projectId, sessionId, input, mode, attachments),
  editPrompt: async (projectId, sessionId, userMessageIndex, input, mode, attachments) => await ipcRenderer.invoke(desktopIpc.editPrompt, projectId, sessionId, userMessageIndex, input, mode, attachments),
  cancelRun: async (projectId) => await ipcRenderer.invoke(desktopIpc.cancelRun, projectId),
  resolvePermission: async (projectId, requestId, result) => await ipcRenderer.invoke(desktopIpc.resolvePermission, projectId, requestId, result),
  setPermissionMode: async (projectId, mode) => await ipcRenderer.invoke(desktopIpc.setPermissionMode, projectId, mode),
  switchModel: async (projectId, alias, thinking) => await ipcRenderer.invoke(desktopIpc.switchModel, projectId, alias, thinking),
  saveModelConfiguration: async (projectId, configuration) => await ipcRenderer.invoke(desktopIpc.saveModelConfiguration, projectId, configuration),
  testModelConfiguration: async (projectId, configuration) => await ipcRenderer.invoke(desktopIpc.testModelConfiguration, projectId, configuration),
  removeModelConfiguration: async (projectId, alias) => await ipcRenderer.invoke(desktopIpc.removeModelConfiguration, projectId, alias),
  startModelLogin: async (projectId, provider) => await ipcRenderer.invoke(desktopIpc.startModelLogin, projectId, provider),
  completeModelLogin: async (projectId, provider, authRequestId, pastedAuthorization) => await ipcRenderer.invoke(desktopIpc.completeModelLogin, projectId, provider, authRequestId, pastedAuthorization),
  cancelModelLogin: async (projectId, provider, authRequestId) => await ipcRenderer.invoke(desktopIpc.cancelModelLogin, projectId, provider, authRequestId),
  compact: async (projectId, hint) => await ipcRenderer.invoke(desktopIpc.compact, projectId, hint),
  saveAttachment: async (projectId, name, mimeType, bytes) => await ipcRenderer.invoke(desktopIpc.saveAttachment, projectId, name, mimeType, bytes),
  resolveDroppedFile: (file) => webUtils.getPathForFile(file),
  listWorkspaceDirectory: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.listWorkspaceDirectory, projectId, relativePath),
  readWorkspaceFile: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.readWorkspaceFile, projectId, relativePath),
  openWorkspaceFile: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.openWorkspaceFile, projectId, relativePath),
  openExternal: async (url) => await ipcRenderer.invoke(desktopIpc.openExternal, url),
  setSidebarWidth: async (width) => await ipcRenderer.invoke(desktopIpc.setSidebarWidth, width),
  setFilePanelWidth: async (width) => await ipcRenderer.invoke(desktopIpc.setFilePanelWidth, width),
  onAgentEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, envelope: DesktopAgentEventEnvelope): void => listener(envelope);
    ipcRenderer.on(desktopIpc.event, handler);
    return () => ipcRenderer.removeListener(desktopIpc.event, handler);
  },
  onMenuAction(listener) {
    const handler = (_event: Electron.IpcRendererEvent, action: DesktopMenuAction): void => listener(action);
    ipcRenderer.on(desktopIpc.menuAction, handler);
    return () => ipcRenderer.removeListener(desktopIpc.menuAction, handler);
  }
};

contextBridge.exposeInMainWorld("biny", api);
