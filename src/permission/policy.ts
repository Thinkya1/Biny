export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "search_files"
  | "run_command";

const SAFE_AUTO_ALLOW = new Set<ToolName>(["read_file", "list_files", "search_files"]);

export function requiresConfirmation(toolName: ToolName): boolean {
  // 只读工具默认放行；写文件、编辑和命令执行必须进入确认流程。
  return !SAFE_AUTO_ALLOW.has(toolName);
}

export function commandSafetyWarnings(command: string): string[] {
  const warnings: string[] = [];
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();

  // 这里目前只是第一层保守规则。后续 Shell 安全增强时，应替换为命令解析和路径级权限判断。
  if (/(^|[;&|]\s*)rm(\s|$)/.test(normalized)) warnings.push("contains rm");
  if (/(^|[;&|]\s*)sudo(\s|$)/.test(normalized)) warnings.push("contains sudo");
  if (/(^|[;&|]\s*)chmod(\s|$)/.test(normalized)) warnings.push("contains chmod");
  if (/(^|[;&|]\s*)git push(\s|$)/.test(normalized)) warnings.push("contains git push");
  if (/(^|[;&|]\s*)npm install(\s|$)/.test(normalized)) warnings.push("contains npm install");
  if (/(^|[;&|]\s*)pnpm install(\s|$)/.test(normalized)) warnings.push("contains pnpm install");

  return warnings;
}
