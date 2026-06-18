export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "grep_search"
  | "run_command"
  | "git_status"
  | "git_diff";

const SAFE_AUTO_ALLOW = new Set<ToolName>(["read_file", "list_files", "grep_search", "git_status", "git_diff"]);

export function requiresConfirmation(toolName: ToolName): boolean {
  return !SAFE_AUTO_ALLOW.has(toolName);
}
