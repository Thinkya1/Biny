import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, Notification, safeStorage, shell } from "electron";
import type { DesktopBootstrap } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";
import { DesktopAgentManager } from "./DesktopAgentManager.js";
import { DesktopConfigStore } from "./DesktopConfigStore.js";
import { DesktopProjectService } from "./DesktopProjectService.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopUserDataStore } from "./DesktopUserDataStore.js";
import { registerDesktopIpc } from "./ipc.js";
import { installApplicationMenu } from "./menu.js";
import { createDesktopWindow, type WindowCloseDecision } from "./window.js";

app.setName("Biny");
app.setAboutPanelOptions({
  applicationName: "Biny",
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: "Biny local agent"
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void startDesktopApplication().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    dialog.showErrorBox("Biny 无法启动", message);
    app.quit();
  });
}

async function startDesktopApplication(): Promise<void> {
  await app.whenReady();
  setDesktopIcon();
  const legacyDataRoot = app.getPath("userData");
  const desktopRoot = path.join(legacyDataRoot, "workspaces", "default");
  const storage = new DesktopUserDataStore(desktopRoot);
  await storage.initialize();
  await storage.migrateLegacyState(path.join(legacyDataRoot, "desktop-state.json"), path.join(desktopRoot, "desktop-state.json"));
  const state = new DesktopStateStore(path.join(desktopRoot, "desktop-state.json"));
  await state.load();
  const configStore = new DesktopConfigStore(desktopRoot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64"))
  });
  await storage.migrateLegacyConfig(state.projects(), configStore);
  const projects = new DesktopProjectService(state, storage, configStore);
  let mainWindow: BrowserWindow | undefined;
  let preparingQuit = false;
  const agents = new DesktopAgentManager(state, projects, configStore, (projectId, event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(desktopIpc.event, { projectId, event });
    }
    if (event.type === "permission.requested" && (!mainWindow || !mainWindow.isFocused() || !mainWindow.isVisible()) && Notification.isSupported()) {
      new Notification({
        title: "Biny 等待权限",
        body: event.request.changeSummary ?? event.request.title,
        silent: true
      }).show();
    }
  }, async (url) => await shell.openExternal(url));

  const bootstrap = async (): Promise<DesktopBootstrap> => {
    const allProjects = await projects.refreshAllProjects();
    let activeProjectId = state.activeProjectId();
    if (activeProjectId && !allProjects.some((project) => project.id === activeProjectId)) activeProjectId = undefined;
    activeProjectId ??= allProjects.at(0)?.id;
    if (activeProjectId !== state.activeProjectId()) await state.setActiveProject(activeProjectId);
    const workspace = activeProjectId ? await agents.workspaceSnapshot(activeProjectId) : undefined;
    return {
      version: app.getVersion(),
      platform: process.platform,
      projects: state.projects(),
      activeProjectId,
      selectedSessionId: activeProjectId ? state.selectedSessionId(activeProjectId) : undefined,
      workspace,
      sidebarWidth: state.sidebarWidth(),
      filePanelWidth: state.filePanelWidth(),
      themePreference: state.themePreference()
    };
  };

  const decideWindowClose = async (): Promise<WindowCloseDecision> => {
    if (!agents.hasRunningTasks()) return "close";
    const response = await showMessage(mainWindow, {
      type: "question",
      title: "任务仍在运行",
      message: "Biny 仍有正在运行或等待权限的任务。",
      detail: "你可以让任务留在后台、停止任务并关闭窗口，或取消关闭。",
      buttons: ["保持后台运行", "中止并关闭", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (response.response === 0) return "hide";
    if (response.response === 1) {
      agents.cancelAll();
      return "close";
    }
    return "cancel";
  };

  const createWindow = (): BrowserWindow => {
    mainWindow = createDesktopWindow(state, decideWindowClose);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
    return mainWindow;
  };

  registerDesktopIpc({ state, projects, agents, getWindow: () => mainWindow, bootstrap });
  installApplicationMenu(() => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    event.preventDefault();
    if (preparingQuit) return;
    preparingQuit = true;
    void (async () => {
      if (agents.hasRunningTasks()) {
        const response = await showMessage(mainWindow, {
          type: "warning",
          title: "退出 Biny",
          message: "退出会中止所有正在运行的任务。",
          buttons: ["中止并退出", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        if (response.response !== 0) {
          preparingQuit = false;
          return;
        }
        agents.cancelAll();
      }
      mainWindow?.destroy();
      try {
        await Promise.race([
          agents.closeAll(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000))
        ]);
      } finally {
        app.exit(0);
      }
    })();
  });
}

function setDesktopIcon(): void {
  if (process.platform !== "darwin") return;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.icns")
    : path.join(app.getAppPath(), "build/icon-master.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

async function showMessage(
  window: BrowserWindow | undefined,
  options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
  return window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
}
