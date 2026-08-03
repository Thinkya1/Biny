/** Desktop preload 边界的共享错误文案与错误归一化。 */
export const desktopApiVersionMismatchMessage = "桌面端资源版本不一致，请完全退出 Biny 后重新启动。";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
