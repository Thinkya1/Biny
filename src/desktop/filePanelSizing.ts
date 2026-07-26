/**
 * 文件面板宽度约束。
 *
 * 主进程（持久化宽度）和渲染进程（拖拽时实时收敛）共用同一套上下限，避免两边算出
 * 不同的宽度导致重启后面板跳动。
 */
export const DEFAULT_FILE_PANEL_WIDTH = 460;
export const MIN_FILE_PANEL_WIDTH = 320;
export const MAX_FILE_PANEL_WIDTH = 720;

const MIN_CONVERSATION_WIDTH = 320;
const OVERLAY_GUTTER = 44;

/** 持久化前只收敛到固定上下限，此时还不知道窗口宽度。 */
export function clampStoredFilePanelWidth(width: number): number {
  return Math.min(MAX_FILE_PANEL_WIDTH, Math.max(MIN_FILE_PANEL_WIDTH, Math.round(width)));
}

/**
 * 按当前工作区宽度收敛面板宽度。并排展示时要给对话区留出可用宽度；浮层模式下面板盖在
 * 对话之上，只需留一点边距。窗口过窄时下限优先，宁可挤掉对话区也不让面板小到不可用。
 */
export function clampFilePanelWidth(width: number, workspaceWidth: number, overlay: boolean): number {
  const reservedWidth = overlay ? OVERLAY_GUTTER : MIN_CONVERSATION_WIDTH;
  const availableWidth = Math.max(MIN_FILE_PANEL_WIDTH, Math.floor(workspaceWidth - reservedWidth));
  const maximumWidth = Math.min(MAX_FILE_PANEL_WIDTH, availableWidth);
  return Math.min(maximumWidth, Math.max(MIN_FILE_PANEL_WIDTH, Math.round(width)));
}
