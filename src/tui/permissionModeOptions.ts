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

export function movePermissionModeSelection(current: number, direction: number): number {
  return (current + direction + permissionModeOptions.length) % permissionModeOptions.length;
}
