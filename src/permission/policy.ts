/**
 * 权限风险识别模块。
 *
 * 这里只负责把工具调用归类为 actionType/riskLevel，并给出人可读 reason。是否允许执行由
 * PermissionManager 统一决定。
 */
import type { ActionType, PermissionRequestContext, RiskLevel } from "./PermissionManager.js";
import type { ToolRisk } from "../tools/types.js";
import { isProtectedCredentialPath } from "../utils/secrets.js";
import path from "node:path";

export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "search_files"
  | "grep_search"
  | "git_status"
  | "git_diff"
  | "run_command"
  | "web_search";

export interface AnalyzePermissionInput {
  toolName: string;
  args: unknown;
  sessionId: string;
  projectRoot: string;
  toolRisk?: ToolRisk;
}

export function analyzePermissionRequest(input: AnalyzePermissionInput): PermissionRequestContext {
  const targetPath = normalizePermissionPath(getStringField(input.args, "path"));

  if (input.toolName === "read_file") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: isSensitivePath(targetPath) ? "critical" : "low",
      targetPath,
      reason: isSensitivePath(targetPath) ? "reads a sensitive file" : "reads a workspace file"
    };
  }

  if (input.toolName === "list_files" || input.toolName === "search_files" || input.toolName === "grep_search") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches or lists workspace files"
    };
  }

  if (input.toolName === "git_status" || input.toolName === "git_diff") {
    return {
      ...base(input),
      actionType: "git",
      riskLevel: "low",
      reason: input.toolName === "git_diff" ? "inspects git diff" : "inspects git status"
    };
  }

  if (input.toolName === "write_file" || input.toolName === "edit_file") {
    return {
      ...base(input),
      actionType: "write",
      riskLevel: fileWriteRisk(targetPath),
      targetPath,
      reason: fileWriteReason(targetPath)
    };
  }

  if (input.toolName === "run_command") {
    return analyzeCommand(input, getStringField(input.args, "command"));
  }

  if (input.toolName === "delegate_task") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "delegates a bounded read-only repository investigation"
    };
  }

  if (input.toolName === "web_search") {
    return {
      ...base(input),
      actionType: "read",
      riskLevel: "low",
      reason: "searches the public web without changing local state"
    };
  }

  if (input.toolRisk === "read") {
    return { ...base(input), actionType: "read", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a read-only action" };
  }
  if (input.toolRisk === "write") {
    return { ...base(input), actionType: "write", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares a workspace-changing action" };
  }
  if (input.toolRisk === "execute") {
    return { ...base(input), actionType: "shell", riskLevel: "medium", targetPath: targetPath || undefined, reason: "extension declares an executable action" };
  }

  return {
    ...base(input),
    actionType: "unknown",
    riskLevel: "medium",
    targetPath: targetPath || undefined,
    reason: "unknown tool action"
  };
}

export function commandSafetyWarnings(command: string): string[] {
  const request = analyzeCommand({ toolName: "run_command", args: { command }, sessionId: "", projectRoot: "" }, command);
  if (request.riskLevel === "low") return [];
  return request.reason ? [request.reason] : ["command requires permission"];
}

function analyzeCommand(input: AnalyzePermissionInput, command: string): PermissionRequestContext {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  const critical = criticalCommandReason(normalized);
  if (critical) {
    return { ...base(input), actionType: commandAction(normalized, "critical"), riskLevel: "critical", command, reason: critical };
  }

  const high = highRiskCommandReason(normalized);
  if (high) {
    return { ...base(input), actionType: commandAction(normalized, "high"), riskLevel: "high", command, reason: high };
  }

  return {
    ...base(input),
    actionType: "shell",
    riskLevel: "medium",
    command,
    reason: testCommandReason(normalized) ?? "executes a shell command"
  };
}

function criticalCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)sudo(\s|$)/.test(command)) return "executes sudo";
  if (/(curl|wget)[^|;&]*\|\s*(sh|bash|zsh)\b/.test(command)) return "pipes a network script into a shell";
  if (/(^|[;&|]\s*)rm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/.test(command)) return "recursively force deletes files";
  if (/(^|[;&|]\s*)git\s+push\b.*\s(--force|-f)(\s|$)/.test(command)) return "force pushes git history";
  return undefined;
}

function highRiskCommandReason(command: string): string | undefined {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "deletes files";
  if (/(^|[;&|]\s*)mv(\s|$)/.test(command)) return "moves or overwrites files";
  if (/(^|[;&|]\s*)chmod(\s|$)/.test(command)) return "changes file permissions";
  if (/(^|[;&|]\s*)chown(\s|$)/.test(command)) return "changes file ownership";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "changes dependencies";
  if (/(^|[;&|]\s*)git\s+(commit|push|reset|checkout|clean|rebase|merge)\b/.test(command)) return "changes git state";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command)) return "accesses the network";
  if (/https?:\/\//.test(command)) return "accesses the network";
  return undefined;
}

function testCommandReason(command: string): string | undefined {
  if (/^(pnpm|npm|yarn|bun)\s+(test|run\s+test|typecheck|run\s+typecheck|lint|run\s+lint)\b/.test(command)) return "runs project checks";
  return undefined;
}

function commandAction(command: string, riskLevel: RiskLevel): ActionType {
  if (/(^|[;&|]\s*)rm(\s|$)/.test(command)) return "delete";
  if (/(^|[;&|]\s*)git\b/.test(command)) return "git";
  if (/(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/.test(command)) return "install";
  if (/(^|[;&|]\s*)(curl|wget)\b/.test(command) || /https?:\/\//.test(command)) return "network";
  return riskLevel === "critical" ? "shell" : "shell";
}

function fileWriteRisk(filePath: string): RiskLevel {
  if (isSensitivePath(filePath)) return "high";
  if (isShellProfile(filePath)) return "critical";
  if (isLockfile(filePath)) return "high";
  return "medium";
}

function fileWriteReason(filePath: string): string {
  if (isShellProfile(filePath)) return "modifies a shell profile";
  if (isSensitivePath(filePath)) return "modifies a sensitive file";
  if (isLockfile(filePath)) return "modifies a lockfile";
  return "modifies a workspace file";
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return isProtectedCredentialPath(normalized)
    || normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.startsWith(".ssh/")
    || normalized.endsWith("/.env")
    || normalized.includes("/.ssh/");
}

function isLockfile(filePath: string): boolean {
  return ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"].includes(filePath);
}

function isShellProfile(filePath: string): boolean {
  return [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"].includes(filePath);
}

function base(input: AnalyzePermissionInput): Pick<PermissionRequestContext, "toolName" | "sessionId" | "projectRoot"> {
  return {
    toolName: input.toolName,
    sessionId: input.sessionId,
    projectRoot: input.projectRoot
  };
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function normalizePermissionPath(value: string): string {
  if (!value) return "";
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}
