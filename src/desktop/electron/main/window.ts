import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";
import { DesktopStateStore } from "./DesktopStateStore.js";

export type WindowCloseDecision = "hide" | "close" | "cancel";

export function createDesktopWindow(
  state: DesktopStateStore,
  decideClose: () => Promise<WindowCloseDecision>
): BrowserWindow {
  const savedBounds = visibleBounds(state.windowBounds());
  const window = new BrowserWindow({
    width: savedBounds?.width ?? 1480,
    height: savedBounds?.height ?? 920,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 960,
    minHeight: 650,
    show: false,
    backgroundColor: "#ffffff",
    title: "Biny",
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? true : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(fileURLToPath(new URL(".", import.meta.url)), "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  let allowClose = false;
  let closePromptOpen = false;
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;
  const saveBounds = (): void => {
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!window.isDestroyed()) void state.setWindowBounds(window.getBounds());
    }, 180);
  };
  window.on("move", saveBounds);
  window.on("resize", saveBounds);
  window.on("close", (event) => {
    if (allowClose) return;
    if (closePromptOpen) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closePromptOpen = true;
    void decideClose().then((decision) => {
      closePromptOpen = false;
      if (window.isDestroyed()) return;
      if (decision === "hide") window.hide();
      if (decision === "close") {
        allowClose = true;
        window.close();
      }
    });
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (url.startsWith("file://") || (developmentUrl && url.startsWith(developmentUrl))) return;
    event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(path.join(fileURLToPath(new URL(".", import.meta.url)), "../renderer/index.html"));
  return window;
}

function visibleBounds(bounds: ReturnType<DesktopStateStore["windowBounds"]>): ReturnType<DesktopStateStore["windowBounds"]> {
  if (!bounds) return undefined;
  const intersects = screen.getAllDisplays().some((display) => {
    const left = Math.max(bounds.x ?? 0, display.bounds.x);
    const top = Math.max(bounds.y ?? 0, display.bounds.y);
    const right = Math.min((bounds.x ?? 0) + bounds.width, display.bounds.x + display.bounds.width);
    const bottom = Math.min((bounds.y ?? 0) + bounds.height, display.bounds.y + display.bounds.height);
    return right - left >= 120 && bottom - top >= 80;
  });
  return intersects ? bounds : undefined;
}
