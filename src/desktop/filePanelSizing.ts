export const DEFAULT_FILE_PANEL_WIDTH = 460;
export const MIN_FILE_PANEL_WIDTH = 320;
export const MAX_FILE_PANEL_WIDTH = 720;

const MIN_CONVERSATION_WIDTH = 320;
const OVERLAY_GUTTER = 44;

export function clampStoredFilePanelWidth(width: number): number {
  return Math.min(MAX_FILE_PANEL_WIDTH, Math.max(MIN_FILE_PANEL_WIDTH, Math.round(width)));
}

export function clampFilePanelWidth(width: number, workspaceWidth: number, overlay: boolean): number {
  const reservedWidth = overlay ? OVERLAY_GUTTER : MIN_CONVERSATION_WIDTH;
  const availableWidth = Math.max(MIN_FILE_PANEL_WIDTH, Math.floor(workspaceWidth - reservedWidth));
  const maximumWidth = Math.min(MAX_FILE_PANEL_WIDTH, availableWidth);
  return Math.min(maximumWidth, Math.max(MIN_FILE_PANEL_WIDTH, Math.round(width)));
}
