import type { PermissionResult } from "../../permission/PermissionManager.js";
import type { PermissionChoice } from "../types.js";

/** 把 TUI 三个按钮转换成运行时权限结果。 */
export function permissionChoiceToResult(choice: PermissionChoice, requireFullYes: boolean): PermissionResult {
  if (choice === "approve_once") {
    return { approved: true, scope: "once", confirmation: requireFullYes ? "yes" : undefined };
  }
  if (choice === "approve_command") {
    return { approved: true, scope: "command", confirmation: requireFullYes ? "yes" : undefined };
  }
  return { approved: false, scope: "once", message: "Denied by user.", confirmation: undefined };
}
