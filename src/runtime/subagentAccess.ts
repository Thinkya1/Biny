/**
 * 子 agent 的权限档位推导。
 *
 * 单独放一个文件，是为了让「派发任务」的各个入口（TUI、桌面端、工具层）都走同一条
 * 判断，不各自拍脑袋决定子 agent 能不能写工作区。
 */
import type { PermissionManager } from "../permission/PermissionManager.js";
import type { SubagentAccessMode } from "./SubagentTaskManager.js";

/**
 * 子任务继承当前交互会话的权限姿态：只有 full-access 才允许子 agent 写工作区。
 * 一次「同意派发任务」的授权不等于放开写权限，否则 ask / read-only 会话会被悄悄提权。
 */
export function subagentAccessMode(permissionManager: PermissionManager): SubagentAccessMode {
  return permissionManager.getStatus().mode === "full-access" ? "workspace" : "read-only";
}
