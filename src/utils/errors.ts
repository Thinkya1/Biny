/**
 * 错误展示辅助模块。
 *
 * JavaScript 抛出的值不一定是 Error。这个小工具把 unknown 错误统一压成字符串，供命令层、
 * TUI 和日志展示使用，避免各处重复写 `instanceof Error` 判断。
 */
export function errorMessage(error: unknown): string {
  // 统一把 unknown error 转成可展示字符串，避免各处重复 instanceof 判断。
  return error instanceof Error ? error.message : String(error);
}
