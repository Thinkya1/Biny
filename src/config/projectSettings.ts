/**
 * 项目级配置覆盖。
 *
 * 这里故意不复用完整 AgentConfig schema：项目文件只能表达运行参数，不能借此引入 provider、
 * model alias、API key、OAuth 或其他全局凭据。解析后再和全局配置做深度合并。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectBinyDir, projectSettingsPath } from "./paths.js";
import { reasoningEffortSchema } from "./schema.js";

const maxConfigFileBytes = 1024 * 1024;

const thinkingOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  effort: reasoningEffortSchema.optional()
}).strict();

const agentOverrideSchema = z.object({
  softStepLimit: z.number().int().min(1).max(1_024).optional(),
  hardStepLimit: z.number().int().min(1).max(1_024).optional(),
  maxToolCalls: z.number().int().min(1).max(65_536).optional(),
  maxProviderRetries: z.number().int().min(0).max(5).optional(),
  maxCompletionContinuations: z.number().int().min(0).max(32).optional(),
  maxRepeatedActions: z.number().int().min(1).max(32).optional(),
  maxConcurrentTools: z.number().int().min(1).max(32).optional(),
  maxQueuedToolCalls: z.number().int().min(1).max(1_024).optional()
}).strict();

const permissionOverrideSchema = z.object({
  mode: z.enum(["safe", "ask", "read-only", "auto", "full-access"]).optional(),
  allowTools: z.array(z.string()).optional(),
  allowPaths: z.array(z.string()).optional(),
  denyPaths: z.array(z.string()).optional(),
  criticalAlwaysAsk: z.boolean().optional()
}).strict();

const memoryOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  autoRemember: z.boolean().optional(),
  maxRecalled: z.number().int().min(1).max(20).optional(),
  model: z.string().min(1).optional()
}).strict();

const contextOverrideSchema = z.object({
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  maxTurnToolResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024).optional(),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).optional(),
  memory: memoryOverrideSchema.optional()
}).strict();

const sandboxOverrideSchema = z.object({
  mode: z.enum(["off", "workspace-write"]).optional(),
  allowNetwork: z.boolean().optional()
}).strict();

const checkpointsOverrideSchema = z.object({ enabled: z.boolean().optional() }).strict();

const diagnosticsOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  autoDetect: z.boolean().optional(),
  autoDetectTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  maxOutputBytes: z.number().int().min(256).max(1024 * 1024).optional(),
  commands: z.array(z.object({
    extensions: z.array(z.string().min(1).startsWith(".")).min(1).max(16),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional()
  }).strict()).max(8).optional()
}).strict();

export const projectSettingsSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  thinking: thinkingOverrideSchema.optional(),
  agent: agentOverrideSchema.optional(),
  permission: permissionOverrideSchema.optional(),
  context: contextOverrideSchema.optional(),
  sandbox: sandboxOverrideSchema.optional(),
  checkpoints: checkpointsOverrideSchema.optional(),
  diagnostics: diagnosticsOverrideSchema.optional()
}).strict();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export async function loadProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const settingsPath = projectSettingsPath(canonicalWorkspace);
  let raw: string;
  try {
    const binyStat = await fs.lstat(projectBinyDir(canonicalWorkspace));
    if (binyStat.isSymbolicLink() || !binyStat.isDirectory()) throw new Error("Project .biny must be a real directory.");
    const settingsStat = await fs.lstat(settingsPath);
    if (settingsStat.isSymbolicLink() || !settingsStat.isFile() || settingsStat.nlink !== 1) {
      throw new Error("Project .biny/settings.json must be a single-link regular file, not a symbolic link or hardlink.");
    }
    if (settingsStat.size > maxConfigFileBytes) {
      throw new Error(`Project .biny/settings.json exceeds the ${String(maxConfigFileBytes)}-byte size limit.`);
    }
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new Error(`Failed to load project .biny/settings.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return projectSettingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid project .biny/settings.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
