/**
 * 桌面端左侧栏宽度约束。
 *
 * 渲染进程拖拽、主进程持久化和重启恢复必须使用同一组边界，否则拖到边界后的宽度会在
 * 保存或重新打开窗口时跳回另一组值。
 */
export const DEFAULT_SIDEBAR_WIDTH = 260;
export const COMPACT_SIDEBAR_WIDTH = 74;
export const COMPACT_SIDEBAR_THRESHOLD = COMPACT_SIDEBAR_WIDTH + 12;
export const MIN_SIDEBAR_WIDTH = COMPACT_SIDEBAR_WIDTH;
export const MAX_SIDEBAR_WIDTH = 360;

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function isCompactSidebarWidth(width: number): boolean {
  return clampSidebarWidth(width) <= COMPACT_SIDEBAR_THRESHOLD;
}
