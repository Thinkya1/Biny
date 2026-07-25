/**
 * Ink terminal resize recovery.
 *
 * Terminal reflow leaves ghost cells that Ink's eraseLines cannot remove. Ink's
 * default resize handler also repaints immediately from stale log-update state,
 * which stacks full frames into the scrollback ("折叠" piles of the same header).
 *
 * Strategy: take over resize entirely. While the user drags, only clear + reset.
 * After the size settles, React's debounced window size triggers one clean paint.
 */
import type { Writable } from "node:stream";

/** Clear visible screen only (do not wipe scrollback with CSI 3J). */
const CLEAR_SCREEN = "\u001B[2J\u001B[H";
const RESIZE_SETTLE_MS = 80;

interface InkLog {
  reset(): void;
}

interface ThrottledFn {
  cancel?: () => void;
}

/** Minimal surface of Ink's private instance used for resize recovery. */
export interface InkRendererInstance {
  lastOutput: string;
  lastOutputToRender: string;
  lastOutputHeight: number;
  fullStaticOutput: string;
  lastTerminalWidth: number;
  log: InkLog;
  throttledLog?: ThrottledFn;
  throttledOnRender?: ThrottledFn;
  resized: () => void;
  onRender: () => void;
  calculateLayout: () => void;
  unsubscribeResize?: () => void;
}

type InstanceMap = WeakMap<Writable, InkRendererInstance>;

let cachedInstances: InstanceMap | undefined;
let instancesPromise: Promise<InstanceMap | undefined> | undefined;

async function loadInkInstances(): Promise<InstanceMap | undefined> {
  try {
    const inkEntry = import.meta.resolve("ink");
    const instancesUrl = new URL("./instances.js", inkEntry);
    const mod = await import(instancesUrl.href) as { default: InstanceMap };
    return mod.default;
  } catch {
    return undefined;
  }
}

export function getInkRenderer(stdout: Writable): InkRendererInstance | undefined {
  if (!cachedInstances) return undefined;
  return cachedInstances.get(stdout);
}

export async function warmInkRendererAccess(): Promise<void> {
  if (cachedInstances) return;
  instancesPromise ??= loadInkInstances();
  cachedInstances = await instancesPromise;
}

function clearVisibleScreen(stdout: NodeJS.WriteStream): void {
  try {
    stdout.write(CLEAR_SCREEN);
  } catch {
    // Stream may be closing during exit.
  }
}

function resetRendererState(ink: InkRendererInstance): void {
  ink.throttledLog?.cancel?.();
  ink.throttledOnRender?.cancel?.();
  ink.lastOutput = "";
  ink.lastOutputToRender = "";
  ink.lastOutputHeight = 0;
  ink.fullStaticOutput = "";
  ink.log.reset();
}

/**
 * Replace Ink's resize handler. Returns a disposer that restores the original.
 * If the private renderer cannot be resolved, installs a no-op disposer — we
 * must not clearTerminal without resetting log state (that causes worse ghosts).
 */
export function installInkResizeRecovery(stdout: NodeJS.WriteStream): () => void {
  const ink = getInkRenderer(stdout);
  if (!ink || typeof ink.resized !== "function") {
    return () => undefined;
  }

  // Stop Ink from repainting on every SIGWINCH; that is what stacks frames.
  stdout.removeListener("resize", ink.resized);

  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const onResize = (): void => {
    resetRendererState(ink);
    clearVisibleScreen(stdout);
    // Keep lastTerminalWidth in sync so a restored handler behaves correctly.
    ink.lastTerminalWidth = stdout.columns || ink.lastTerminalWidth;

    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      // Ensure the next React/Ink paint is a full write, not an incremental patch
      // against a frame that was never shown (we cleared during the drag).
      resetRendererState(ink);
      try {
        ink.calculateLayout();
        // React may not re-render if debounced size matches an intermediate value;
        // force one paint from the current tree at the settled terminal size.
        ink.onRender();
      } catch {
        // Best-effort during teardown.
      }
    }, RESIZE_SETTLE_MS);
  };

  stdout.on("resize", onResize);

  // Keep Ink's internal unsubscribe pointed at our handler so unmount is clean.
  ink.unsubscribeResize = () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    stdout.removeListener("resize", onResize);
  };

  return () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    stdout.removeListener("resize", onResize);
  };
}

export const resizeSettleMs = RESIZE_SETTLE_MS;
