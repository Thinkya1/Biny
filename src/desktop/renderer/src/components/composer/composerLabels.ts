/** Composer 菜单共享的标签与说明，不包含 React 状态。 */
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";

export const permissionOptions: Array<{ mode: PermissionMode; label: string; description: string; risk?: string }> = [
  { mode: "ask", label: "每次询问", description: "写入、执行和其他敏感操作会请求确认" },
  { mode: "auto", label: "自动允许安全修改", description: "自动允许低风险操作，其他操作仍会询问" },
  { mode: "read-only", label: "只读", description: "允许读取，拒绝修改和命令执行" },
  { mode: "full-access", label: "完全访问", description: "除项目规定的关键操作外自动允许", risk: "高风险" }
];

export function permissionLabel(mode: PermissionMode): string {
  return permissionOptions.find((option) => option.mode === mode)?.label ?? mode;
}

const thinkingLabels: Record<ThinkingSelection, string> = {
  off: "标准",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "较高",
  max: "最高"
};

export function thinkingLabel(value: ThinkingSelection): string {
  return thinkingLabels[value] ?? value;
}

export function thinkingDescription(value: ThinkingSelection): string {
  return value === "off" ? "不额外要求模型思考，回复最快" : "思考越多越慢，但复杂任务更稳";
}
