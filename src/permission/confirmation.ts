/**
 * 权限确认答案解析模块。
 *
 * CLI 和 TUI 共用这里的纯逻辑，确保强确认不会因不同交互入口而降级。
 */
import type { PermissionResult } from "./PermissionManager.js";

const fullYesConfirmation = "yes";

/** 强确认只接受完整的 yes；忽略首尾空白和大小写。 */
export function isFullYesConfirmation(answer: string): boolean {
  return normalizeAnswer(answer) === fullYesConfirmation;
}

export function permissionResultFromAnswer(answer: string, requireFullYes: boolean): PermissionResult {
  const normalized = normalizeAnswer(answer);
  if (requireFullYes) {
    if (normalized === fullYesConfirmation) return { approved: true, scope: "once", confirmation: fullYesConfirmation };
    if (normalized === `${fullYesConfirmation} command`) return { approved: true, scope: "command", confirmation: fullYesConfirmation };
    return { approved: false, scope: "once", message: "Full yes confirmation was not provided." };
  }
  if (normalized === "" || normalized === "y" || normalized === fullYesConfirmation) {
    return { approved: true, scope: "once" };
  }
  if (normalized === "c") return { approved: true, scope: "command" };
  return { approved: false, scope: "once", message: "Denied by user." };
}

function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/gu, " ");
}
