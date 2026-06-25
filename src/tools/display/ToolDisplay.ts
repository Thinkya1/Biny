/**
 * 工具展示规则模块。
 *
 * 这里只负责把工具调用参数转换成权限确认所需的标题、摘要和 diff。它不执行工具、不记录 session，
 * 也不决定是否允许调用，保证 UI 展示格式不会影响工具协议。
 */
import { promises as fs } from "node:fs";
import { analyzePermissionRequest, commandSafetyWarnings } from "../../permission/policy.js";
import type { PermissionRequestContext } from "../../permission/PermissionManager.js";
import { formatDiffPreviewLines, renderDiffLinesClustered, renderFileContentPreview } from "../../tui/diffPreview.js";
import { createUnifiedDiff } from "../../utils/diff.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { AgentPermissionRequest } from "../../agent/types.js";
import type { LLMToolCall } from "../../llm/provider.js";

export interface ToolDisplayContext {
  workspaceRoot: string;
  ignore: string[];
  sessionId?: string;
}

export interface ToolDisplayRule {
  title: string;
  summarize(args: unknown, context: ToolDisplayContext): Promise<ToolDisplaySummary>;
}

export interface ToolDisplaySummary {
  details: string;
  diff?: string;
  preview?: string;
  requireFullYes?: boolean;
  changeSummary?: string;
}

export async function createToolPermissionRequest(
  call: LLMToolCall,
  context: ToolDisplayContext,
  permissionContext?: PermissionRequestContext
): Promise<AgentPermissionRequest> {
  const requestContext = permissionContext ?? analyzePermissionRequest({
    toolName: call.name,
    args: call.args,
    sessionId: context.sessionId ?? "",
    projectRoot: context.workspaceRoot
  });
  const rule = toolDisplayRules[call.name] ?? defaultDisplayRule;
  const summary = await rule.summarize(call.args, context);
  return {
    ...requestContext,
    tool: call.name,
    title: rule.title,
    details: summary.details,
    requireFullYes: summary.requireFullYes ?? false,
    diff: summary.diff,
    preview: summary.preview,
    diffPreview: summary.diff,
    changeSummary: summary.changeSummary
  };
}

export const toolDisplayRules: Record<string, ToolDisplayRule> = {
  run_command: {
    title: "Command execution request",
    async summarize(args) {
      const command = getStringField(args, "command");
      const warnings = commandSafetyWarnings(command);
      return {
        details: [command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join(""),
        changeSummary: `Run command: ${command}`,
        requireFullYes: warnings.length > 0
      };
    }
  },
  write_file: {
    title: "File write request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const content = getStringField(args, "content");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const diff = oldContent ? createUnifiedDiff(filePath, oldContent, content) : undefined;
      const preview = oldContent
        ? formatDiffPreviewLines(renderDiffLinesClustered(oldContent, content, filePath, { contextLines: 3, maxLines: 16 }))
        : formatDiffPreviewLines(renderFileContentPreview(filePath, content, { maxLines: 16 }));
      return {
        details: `File: ${filePath}\nBytes: ${Buffer.byteLength(content, "utf8")}\n\n${preview}`,
        diff,
        preview,
        changeSummary: oldContent ? `Overwrite ${filePath}` : `Create ${filePath}`
      };
    }
  },
  edit_file: {
    title: "File edit request",
    async summarize(args, context) {
      const filePath = getStringField(args, "path");
      const oldText = getStringField(args, "oldText");
      const newText = getStringField(args, "newText");
      const oldContent = await readExistingFileForDiff(filePath, context);
      const nextContent = oldContent.includes(oldText) ? oldContent.replace(oldText, newText) : oldContent;
      const diff = createUnifiedDiff(filePath, oldContent, nextContent);
      const preview = formatDiffPreviewLines(renderDiffLinesClustered(oldContent, nextContent, filePath, { contextLines: 3, maxLines: 16 }));
      return {
        details: `File: ${filePath}\nReplace bytes: ${Buffer.byteLength(oldText, "utf8")} -> ${Buffer.byteLength(newText, "utf8")}\n\n${preview}`,
        diff,
        preview,
        changeSummary: `Edit ${filePath}`
      };
    }
  }
};

const defaultDisplayRule: ToolDisplayRule = {
  title: "Tool permission request",
  async summarize(args) {
    return { details: JSON.stringify(args, null, 2) };
  }
};

async function readExistingFileForDiff(filePath: string, context: ToolDisplayContext): Promise<string> {
  const absolutePath = resolveWorkspacePath(context.workspaceRoot, filePath, context.ignore);
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function getStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}
