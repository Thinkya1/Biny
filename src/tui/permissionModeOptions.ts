/**
 * 权限模式选择项。
 *
 * 只描述可在界面上切换的三种模式；`read-only` 由外部（如 plan 模式）设置，不出现在
 * 选择列表里，所以 `permissionModeLabel` 需要单独处理它。
 */
import type { PermissionMode } from "../permission/PermissionManager.js";

export interface PermissionModeOption {
  mode: Extract<PermissionMode, "ask" | "auto" | "full-access">;
  label: string;
  description: string;
}

export const permissionModeOptions: PermissionModeOption[] = [
  {
    mode: "ask",
    label: "Ask for approval",
    description: "Ask before file edits, shell commands, and other write actions."
  },
  {
    mode: "auto",
    label: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe."
  },
  {
    mode: "full-access",
    label: "Full Access",
    description: "Allow normal workspace edits and commands without asking; critical actions may still ask."
  }
];

export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read Only";
  return permissionModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}

export function permissionModeOptionIndex(mode: PermissionMode): number {
  const index = permissionModeOptions.findIndex((option) => option.mode === mode);
  return index === -1 ? 0 : index;
}

/** 上下键循环移动选中项，越界时绕回另一端。 */
export function movePermissionModeSelection(current: number, direction: number): number {
  return (current + direction + permissionModeOptions.length) % permissionModeOptions.length;
}
