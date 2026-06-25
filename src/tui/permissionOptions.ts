/**
 * 权限确认选项状态模块。
 *
 * PermissionPrompt 用这里的纯函数处理键盘选择，便于不启动 Ink 就能测试上下移动和 Enter 映射。
 */
import type { PermissionChoice } from "./types.js";

export interface PermissionOption {
  label: string;
  description: string;
  choice: PermissionChoice;
  dangerous?: boolean;
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

export function normalizePermissionSelection(index: number): number {
  if (!Number.isInteger(index)) return 0;
  return (index + permissionOptions.length) % permissionOptions.length;
}
