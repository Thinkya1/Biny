/**
 * Debounce terminal dimensions so React does not re-layout on every SIGWINCH
 * pixel during a drag. Pair with installInkResizeRecovery: while dragging the
 * screen stays cleared; after settle both size and paint update once.
 */
import { useEffect, useState } from "react";
import { useWindowSize } from "ink";
import { resizeSettleMs } from "./inkTerminal.js";

export function useDebouncedWindowSize(delayMs = resizeSettleMs): { columns: number; rows: number } {
  const live = useWindowSize();
  const [size, setSize] = useState(live);

  useEffect(() => {
    if (size.columns === live.columns && size.rows === live.rows) return;
    const timer = setTimeout(() => {
      setSize({ columns: live.columns, rows: live.rows });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, live.columns, live.rows, size.columns, size.rows]);

  return size;
}
