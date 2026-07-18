/**
 * 权限确认选项状态模块。
 *
 * PermissionPrompt 用这里的纯函数处理键盘选择，便于不启动 Ink 就能测试上下移动和 Enter 映射。
 */
import type { PermissionChoice, TuiPermissionRequest } from "./types.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";

export interface PermissionOption {
  label: string;
  description: string;
  choice: PermissionChoice;
  dangerous?: boolean;
}

export interface PermissionPromptInteractionState {
  request?: TuiPermissionRequest;
  selectedIndex: number;
  confirmation: string;
  confirmationAttempted: boolean;
}

export const permissionOptions: PermissionOption[] = [
  { label: "执行", description: "只允许本次操作", choice: "approve_once" },
  { label: "不执行", description: "拒绝本次操作", choice: "reject", dangerous: true },
  { label: "当前命令不再询问", description: "本会话后续相同操作直接执行", choice: "approve_command" }
];

export function movePermissionSelection(currentIndex: number, direction: -1 | 1): number {
  return (currentIndex + direction + permissionOptions.length) % permissionOptions.length;
}

export function permissionChoiceAt(index: number): PermissionChoice {
  return permissionOptions[normalizePermissionSelection(index)]?.choice ?? "approve_once";
}

/** 强确认下，拒绝可以立即提交，批准项必须同时提供完整 yes。 */
export function confirmedPermissionChoice(
  index: number,
  requireFullYes: boolean,
  confirmation: string
): PermissionChoice | undefined {
  const choice = permissionChoiceAt(index);
  if (choice === "reject" || !requireFullYes || isFullYesConfirmation(confirmation)) return choice;
  return undefined;
}

/** 只保留单行可打印输入并限制长度，避免确认行撑破权限框。 */
export function appendPermissionConfirmation(current: string, input: string): string {
  const printable = input.replace(/[\u0000-\u001F\u007F]/gu, "");
  return `${current}${printable}`.slice(0, 16);
}

export function createPermissionPromptInteractionState(
  request?: TuiPermissionRequest
): PermissionPromptInteractionState {
  return { request, selectedIndex: 0, confirmation: "", confirmationAttempted: false };
}

/** 新请求永远从默认选项和空确认词开始，防止复用上一请求的 yes。 */
export function permissionPromptStateForRequest(
  state: PermissionPromptInteractionState,
  request?: TuiPermissionRequest
): PermissionPromptInteractionState {
  return state.request === request ? state : createPermissionPromptInteractionState(request);
}

export function normalizePermissionSelection(index: number): number {
  if (!Number.isInteger(index)) return 0;
  return (index + permissionOptions.length) % permissionOptions.length;
}
