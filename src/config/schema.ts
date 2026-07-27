/**
 * Runtime configuration schema.
 *
 * Providers own credentials and endpoints, while model aliases own model IDs and
 * capabilities. The legacy single `model` object is migrated at the parse boundary.
 */
import { z } from "zod";

const agentSchema = z.object({
  maxSteps: z.number().int().min(1).max(32).default(32),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  maxTaskSteps: z.number().int().min(1).max(1_024).default(96),
  maxWallTimeMs: z.number().int().min(1_000).max(86_400_000).default(30 * 60_000),
  maxTotalTokens: z.number().int().min(1).max(10_000_000).default(500_000),
  maxCostUsd: z.number().positive().max(1_000).optional(),
  maxConcurrentTools: z.number().int().min(1).max(32).default(4),
  maxQueuedToolCalls: z.number().int().min(1).max(1_024).default(64)
}).default({
  maxSteps: 32,
  maxAttempts: 3,
  maxTaskSteps: 96,
  maxWallTimeMs: 30 * 60_000,
  maxTotalTokens: 500_000,
  maxCostUsd: undefined,
  maxConcurrentTools: 4,
  maxQueuedToolCalls: 64
});

const permissionSchema = z.object({
  mode: z.enum(["safe", "ask", "read-only", "auto", "full-access"]).default("ask"),
  allowTools: z.array(z.string()).default(["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"]),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([".env", ".env.local", ".ssh/", "node_modules/"]),
  criticalAlwaysAsk: z.boolean().default(true)
}).default({
  mode: "ask",
  allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"],
  allowPaths: [],
  denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
  criticalAlwaysAsk: true
});

const contextSchema = z.object({
  // 不配置时按当前模型的上下文窗口自动推导；配置了就作为额外上限。
  maxInputTokens: z.number().int().min(2_048).max(2_000_000).optional(),
  // A turn retains this much cumulative tool output in model context. Later
  // results are archived under .agent/tool-results with a bounded preview.
  maxTurnToolResultBytes: z.number().int().min(1_024).max(16 * 1024 * 1024).default(128 * 1024),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).default(32 * 1024),
  memory: z.object({
    enabled: z.boolean().default(true),
    // 任务成功后是否自动抽取一条记忆；关闭后仍可检索与手动 save_memory。
    autoRemember: z.boolean().default(true),
    // 每回合自动注入上下文的最大记忆条数。
    maxRecalled: z.number().int().min(1).max(20).default(3),
    // 记忆抽取/整理使用的模型别名；缺省跟随会话模型。
    model: z.string().min(1).optional()
  }).default({ enabled: true, autoRemember: true, maxRecalled: 3, model: undefined })
}).default({
  maxTurnToolResultBytes: 128 * 1024,
  instructionsMaxBytes: 32 * 1024,
  memory: { enabled: true, autoRemember: true, maxRecalled: 3, model: undefined }
});

export const modelProviderSchema = z.enum([
  "deepseek",
  "openai",
  "anthropic",
  "claude-subscription",
  "openai-codex",
  "gemini",
  "kimi",
  "qwen",
  "ollama",
  "openai-compatible"
]);

export const providerProtocolSchema = z.enum(["anthropic", "openai-compatible"]);
export const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelApiBackendSchema = z.enum(["chat_completions", "responses", "anthropic_messages"]);

export const modelCompatibilitySchema = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
});

const thinkingLevelMapSchema = z.record(z.string(), z.string().min(1).nullable()).superRefine((map, context) => {
  for (const key of Object.keys(map)) {
    if (!thinkingLevelSchema.options.includes(key as z.infer<typeof thinkingLevelSchema>)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Unknown thinking level: ${key}.`
      });
    }
  }
});

const thinkingSchema = z.object({
  enabled: z.boolean().default(true),
  effort: reasoningEffortSchema.default("high")
}).default({ enabled: true, effort: "high" });

const providerConfigSchema = z.object({
  type: modelProviderSchema,
  protocol: providerProtocolSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  requiresApiKey: z.boolean().optional(),
  authMode: z.enum(["api-key", "oauth-bearer"]).optional(),
  oauth: z.object({
    provider: z.enum(["claude-code", "openai-codex"]),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.number().int().positive(),
    accountId: z.string().min(1).optional()
  }).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(6).default(3),
    initialDelayMs: z.number().int().min(0).max(30_000).default(250),
    maxDelayMs: z.number().int().min(0).max(120_000).default(4_000)
  }).optional(),
  modelsEndpoint: z.string().url().optional(),
  apiBackend: z.enum(["chat_completions", "responses"]).optional(),
  compatibility: modelCompatibilitySchema.optional()
}).superRefine((provider, context) => {
  if (provider.type === "openai-compatible" && !provider.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "openai-compatible requires a provider baseUrl."
    });
  }
  if (provider.authMode === "oauth-bearer" && !provider.oauth) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["oauth"],
      message: "oauth-bearer requires OAuth refresh metadata."
    });
  }
  if (provider.oauth?.provider === "claude-code" && provider.type !== "claude-subscription") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Claude OAuth credentials require the claude-subscription provider."
    });
  }
  if (provider.oauth?.provider === "openai-codex" && provider.type !== "openai-codex") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Codex OAuth credentials require the openai-codex provider."
    });
  }
});

const modelPricingSchema = z.object({
  inputPerMillionTokens: z.number().nonnegative().optional(),
  outputPerMillionTokens: z.number().nonnegative().optional(),
  cacheReadPerMillionTokens: z.number().nonnegative().optional(),
  cacheWritePerMillionTokens: z.number().nonnegative().optional()
});

const mcpServerSchema = z.object({
  type: z.enum(["stdio", "http"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  stderr: z.enum(["ignore", "inherit", "pipe"]).default("ignore"),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  enabled: z.boolean().default(true)
}).superRefine((server, context) => {
  // type 省略时按字段推断：有 url 走 http，否则走 stdio。
  const transport = server.type ?? (server.url ? "http" : "stdio");
  if (transport === "stdio" && !server.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio MCP server requires a command" });
  }
  if (transport === "http" && !server.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "http MCP server requires a url" });
  }
});

export const defaultSubagentAllowedTools = [
  "read_file",
  "list_files",
  "search_files",
  "grep_search",
  "git_status",
  "git_diff",
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "apply_patch",
  "move_file",
  "run_command"
] as const;

const subagentToolNameSchema = z.enum(defaultSubagentAllowedTools);

const extensionsSchema = z.object({
  mcp: z.record(mcpServerSchema).default({}),
  skills: z.array(z.string().trim().min(1)).max(32).default([".biny/skills", ".agent/skills"]),
  plugins: z.array(z.string().trim().min(1)).max(32).default([]),
  subagent: z.object({
    enabled: z.boolean().default(true),
    maxSteps: z.number().int().min(1).max(32).default(16),
    maxOutputTokens: z.number().int().min(256).max(32_768).default(8_000),
    maxConcurrentSubagents: z.number().int().min(1).max(8).default(2),
    maxPendingSubagents: z.number().int().min(0).max(128).default(16),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
    model: z.string().min(1).optional(),
    maxCostUsd: z.number().positive().max(100).optional(),
    allowedTools: z.array(subagentToolNameSchema).min(1).default([...defaultSubagentAllowedTools]),
    // 具名子代理定义目录（workspace 相对路径）；全局 ~/.biny/agents 始终生效。
    agentPaths: z.array(z.string().trim().min(1)).max(32).default([".biny/agents", ".agent/agents"])
  }).default({
    enabled: true,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents", ".agent/agents"]
  })
}).default({
  mcp: {},
  skills: [".biny/skills", ".agent/skills"],
  plugins: [],
  subagent: {
    enabled: true,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools],
    agentPaths: [".biny/agents", ".agent/agents"]
  }
});

const webSearchSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["duckduckgo", "google", "tavily", "brave", "anysearch"]).default("anysearch"),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  maxResults: z.number().int().min(1).max(10).default(5)
}).default({
  enabled: true,
  provider: "anysearch",
  apiKey: undefined,
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
});

/**
 * 共享 cookie jar：桌面端内嵌浏览器登录后写入，`web_search` 的 Google provider 和
 * `web_fetch` 读取，用来访问需要登录态的页面。
 *
 * 打开它意味着模型选定的 URL 会带上真实登录凭据（只发给域名匹配的站点）。`web_fetch`
 * 默认不在免确认工具白名单里，每次抓取仍要用户确认，这是这项能力的主要约束。
 */
const webCookiesSchema = z.object({
  enabled: z.boolean().default(true),
  /** jar 文件位置；留空用桌面端 userData 下的共享路径，桌面端与 CLI 因此读到同一份。 */
  path: z.string().min(1).optional()
}).default({ enabled: true, path: undefined });

const webFetchSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  maxBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  // 只在用户明确要抓本机开发服务时开启：关掉的是私网/环回/云元数据地址的防线。
  allowPrivateNetwork: z.boolean().default(false)
}).default({
  enabled: true,
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  allowPrivateNetwork: false
});

const hookSchema = z.object({
  command: z.string().min(1),
  /** 只对这些工具触发；留空表示全部。 */
  tools: z.array(z.string().min(1)).max(32).default([]),
  /** 只对这些扩展名的目标路径触发；留空表示不按扩展名过滤。 */
  extensions: z.array(z.string().min(1).startsWith(".")).max(32).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000)
});

const hooksSchema = z.object({
  /** 工具执行前触发；非零退出会阻止这次调用。 */
  beforeTool: z.array(hookSchema).max(16).default([]),
  /** 工具执行后触发；输出附在结果上，退出码不影响调用结果。 */
  afterTool: z.array(hookSchema).max(16).default([])
}).default({ beforeTool: [], afterTool: [] });

const sandboxSchema = z.object({
  /**
   * `workspace-write`：命令仍以当前用户权限运行，但内核层面只允许写工作区、临时目录和常见
   * 缓存目录。这是独立于命令字符串判定的第二道边界。目前只有 macOS 有实现。
   */
  mode: z.enum(["off", "workspace-write"]).default("off"),
  allowNetwork: z.boolean().default(true)
}).default({ mode: "off", allowNetwork: true });

const checkpointsSchema = z.object({
  /** 每个回合首次改动工作区前自动建一个快照，供 /undo 回退。仅在 git 仓库内生效。 */
  enabled: z.boolean().default(true)
}).default({ enabled: true });

const diagnosticsSchema = z.object({
  enabled: z.boolean().default(true),
  /** 自动识别项目本地已安装的检查工具（目前是 TypeScript）；只用本地二进制，不联网安装。 */
  autoDetect: z.boolean().default(true),
  autoDetectTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  maxOutputBytes: z.number().int().min(256).max(1024 * 1024).default(8 * 1024),
  commands: z.array(z.object({
    extensions: z.array(z.string().min(1).startsWith(".")).min(1).max(16),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)
  })).max(8).default([])
}).default({
  enabled: true,
  autoDetect: true,
  autoDetectTimeoutMs: 120_000,
  maxOutputBytes: 8 * 1024,
  commands: []
});

const webSchema = z.object({
  search: webSearchSchema,
  fetch: webFetchSchema,
  cookies: webCookiesSchema
}).default({
  search: {
    enabled: true,
    provider: "anysearch",
    apiKey: undefined,
    apiKeyEnv: undefined,
    timeoutMs: 10_000,
    maxResults: 5
  },
  fetch: {
    enabled: true,
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
    allowPrivateNetwork: false
  },
  cookies: { enabled: true, path: undefined }
});

const modelThinkingSchema = z.object({
  efforts: z.array(reasoningEffortSchema).min(1).default(["high", "max"]),
  defaultEffort: reasoningEffortSchema.default("high"),
  mapping: z.record(reasoningEffortSchema, z.string().min(1)).optional(),
  budgetTokens: z.record(reasoningEffortSchema, z.number().int().min(256).max(131_072)).optional()
}).superRefine((thinking, context) => {
  if (!thinking.efforts.includes(thinking.defaultEffort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultEffort"],
      message: "defaultEffort must be included in efforts."
    });
  }
});

const modelAliasSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  supportsTools: z.boolean().optional(),
  capabilities: z.object({
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    vision: z.boolean().optional(),
    audio: z.boolean().optional(),
    streaming: z.boolean().optional()
  }).optional(),
  contextWindow: z.number().int().min(4_096).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(131_072).optional(),
  /** Model-level API and compatibility override the provider defaults. */
  apiBackend: modelApiBackendSchema.optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: modelCompatibilitySchema.optional(),
  /** Pi-style canonical capability map. Missing/null levels are unsupported. */
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
  thinking: modelThinkingSchema.optional(),
  reasoning: modelThinkingSchema.optional(),
  pricing: modelPricingSchema.optional()
});

const canonicalConfigSchema = z.object({
  defaultModel: z.string().min(1),
  providers: z.record(providerConfigSchema),
  models: z.record(modelAliasSchema),
  thinking: thinkingSchema,
  agent: agentSchema,
  permission: permissionSchema,
  workspace: z.object({
    ignore: z.array(z.string())
  }),
  context: contextSchema,
  diagnostics: diagnosticsSchema,
  checkpoints: checkpointsSchema,
  sandbox: sandboxSchema,
  hooks: hooksSchema,
  web: webSchema,
  telemetry: z.object({
    enabled: z.boolean().default(true),
    recordInputs: z.boolean().default(false),
    recordOutputs: z.boolean().default(false)
  }).default({ enabled: true, recordInputs: false, recordOutputs: false }),
  extensions: extensionsSchema
}).superRefine((config, context) => {
  const activeModel = config.models[config.defaultModel];
  if (!activeModel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultModel"],
      message: `Unknown default model alias: ${config.defaultModel}`
    });
  }

  for (const [alias, model] of Object.entries(config.models)) {
    const provider = config.providers[model.provider];
    if (!provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", alias, "provider"],
        message: `Unknown provider alias: ${model.provider}`
      });
      continue;
    }
    // Reasoning is opt-in per model. The provider adapter decides how the
    // configured effort maps to its native SDK options.
  }

  const activeReasoning = activeModel ? activeModel.reasoning ?? activeModel.thinking : undefined;
  const activeThinkingLevels = activeModel?.thinkingLevelMap;
  const activeSupportsReasoning = activeThinkingLevels
    ? Object.entries(activeThinkingLevels).some(([level, native]) => level !== "off" && native !== null)
    : activeReasoning !== undefined;
  if (config.thinking.enabled && !activeSupportsReasoning) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "enabled"],
      message: `Model ${config.defaultModel} does not support thinking controls.`
    });
  }
  if (config.thinking.enabled && activeModel?.capabilities?.reasoning === false) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "enabled"],
      message: `Model ${config.defaultModel} does not expose reasoning capability metadata.`
    });
  }
  const activeEfforts = activeThinkingLevels
    ? Object.entries(activeThinkingLevels)
      .filter(([level, native]) => level !== "off" && native !== null)
      .map(([level]) => level)
    : activeReasoning?.efforts ?? [];
  if (config.thinking.enabled && !activeEfforts.includes(config.thinking.effort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "effort"],
      message: `Model ${config.defaultModel} does not support ${config.thinking.effort} effort.`
    });
  }

  if (config.agent.maxCostUsd !== undefined) {
    const pricing = activeModel?.pricing;
    if (
      pricing?.inputPerMillionTokens === undefined
      || pricing.outputPerMillionTokens === undefined
      || pricing.cacheReadPerMillionTokens === undefined
      || pricing.cacheWritePerMillionTokens === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agent", "maxCostUsd"],
        message: `Agent task cost budgets require input, output, cache-read, and cache-write pricing for model ${config.defaultModel}.`
      });
    }
  }

  const memoryAlias = config.context.memory.model;
  if (memoryAlias && !config.models[memoryAlias]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "memory", "model"],
      message: `Unknown memory model alias: ${memoryAlias}`
    });
  }

  const subagentAlias = config.extensions.subagent.model;
  if (subagentAlias) {
    const subagentModel = config.models[subagentAlias];
    if (!subagentModel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Unknown subagent model alias: ${subagentAlias}`
      });
    } else if (subagentModel.supportsTools === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "model"],
        message: `Subagent model ${subagentAlias} does not support tools.`
      });
    }
  }

  if (config.extensions.subagent.maxCostUsd !== undefined) {
    const budgetAlias = subagentAlias ?? config.defaultModel;
    const pricing = config.models[budgetAlias]?.pricing;
    if (
      pricing?.inputPerMillionTokens === undefined
      || pricing.outputPerMillionTokens === undefined
      || pricing.cacheReadPerMillionTokens === undefined
      || pricing.cacheWritePerMillionTokens === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensions", "subagent", "maxCostUsd"],
        message: `Subagent cost stop thresholds require input, output, cache-read, and cache-write pricing for model ${budgetAlias}.`
      });
    }
  }
});

export const configSchema = z.preprocess(migrateLegacyConfig, canonicalConfigSchema);

export type AgentConfig = z.infer<typeof canonicalConfigSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelAliasConfig = z.infer<typeof modelAliasSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ThinkingLevelMap = z.infer<typeof thinkingLevelMapSchema>;
export type ModelApiBackend = z.infer<typeof modelApiBackendSchema>;
export type ModelCompatibility = z.infer<typeof modelCompatibilitySchema>;
export type ModelThinkingConfig = z.infer<typeof modelThinkingSchema>;
export type ModelReasoningConfig = z.infer<typeof thinkingSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ExtensionsConfig = z.infer<typeof extensionsSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type CheckpointsConfig = z.infer<typeof checkpointsSchema>;
export type DiagnosticsConfig = z.infer<typeof diagnosticsSchema>;
export type WebFetchConfig = z.infer<typeof webFetchSchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
export type WebCookiesConfig = z.infer<typeof webCookiesSchema>;
export type WebConfig = z.infer<typeof webSchema>;

const defaultWorkspaceIgnore = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".env",
  ".agent",
  ".DS_Store",
  "PROJECT_DESCRIPTION.local.md",
  "TODO.local.md",
  "ARCHITECTURE.local.md"
];

export const defaultConfig: AgentConfig = {
  defaultModel: "deepseek-v4-flash",
  providers: {
    deepseek: {
      type: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY"
    }
  },
  models: {
    "deepseek-v4-flash": {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      description: "Fast and affordable model for everyday work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: false, streaming: true },
      contextWindow: 128_000,
      thinkingLevelMap: { off: "none" },
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "Frontier model for complex coding, research, and real-world work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      contextWindow: 128_000,
      thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
      thinking: { efforts: ["low", "medium", "high"], defaultEffort: "high", mapping: { low: "low", medium: "medium", high: "high" }, budgetTokens: { low: 2_048, medium: 4_096, high: 8_192 } }
    }
  },
  thinking: { enabled: false, effort: "high" },
  agent: {
    maxSteps: 32,
    maxAttempts: 3,
    maxTaskSteps: 96,
    maxWallTimeMs: 30 * 60_000,
    maxTotalTokens: 500_000,
    maxCostUsd: undefined,
    maxConcurrentTools: 4,
    maxQueuedToolCalls: 64
  },
  permission: {
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search", "save_memory"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    ignore: defaultWorkspaceIgnore
  },
  checkpoints: { enabled: true },
  sandbox: { mode: "off", allowNetwork: true },
  hooks: { beforeTool: [], afterTool: [] },
  diagnostics: {
    enabled: true,
    autoDetect: true,
    autoDetectTimeoutMs: 120_000,
    maxOutputBytes: 8 * 1024,
    commands: []
  },
  context: {
    maxTurnToolResultBytes: 128 * 1024,
    instructionsMaxBytes: 32 * 1024,
    memory: { enabled: true, autoRemember: true, maxRecalled: 3, model: undefined }
  },
  web: {
    search: {
      enabled: true,
      provider: "anysearch",
      apiKey: undefined,
      apiKeyEnv: undefined,
      timeoutMs: 10_000,
      maxResults: 5
    },
    fetch: {
      enabled: true,
      timeoutMs: 15_000,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      allowPrivateNetwork: false
    },
    cookies: { enabled: true, path: undefined }
  },
  telemetry: { enabled: true, recordInputs: false, recordOutputs: false },
  extensions: {
    mcp: {},
    skills: [".biny/skills", ".agent/skills"],
    plugins: [],
    subagent: {
      enabled: true,
      maxSteps: 16,
      maxOutputTokens: 8_000,
      maxConcurrentSubagents: 2,
      maxPendingSubagents: 16,
      timeoutMs: 300_000,
      model: undefined,
      maxCostUsd: undefined,
      allowedTools: [...defaultSubagentAllowedTools],
      agentPaths: [".biny/agents", ".agent/agents"]
    }
  }
};

function migrateLegacyConfig(value: unknown): unknown {
  if (!isRecord(value) || "defaultModel" in value || !isRecord(value.model)) return value;
  const legacy = value.model;
  if (typeof legacy.provider !== "string" || typeof legacy.model !== "string") return value;

  const providerAlias = legacy.provider;
  const modelAlias = legacy.model;
  const provider = {
    type: legacy.provider,
    baseUrl: typeof legacy.baseUrl === "string" ? legacy.baseUrl : undefined,
    apiKey: typeof legacy.apiKey === "string" ? legacy.apiKey : undefined,
    apiKeyEnv: typeof legacy.apiKeyEnv === "string" ? legacy.apiKeyEnv : undefined,
    timeoutMs: typeof legacy.timeoutMs === "number" ? legacy.timeoutMs : undefined
  };
  const thinkingCapability = legacy.provider === "deepseek"
    ? modelAlias === "deepseek-v4-flash"
      ? undefined
      : modelAlias === "deepseek-v4-pro"
        ? { efforts: ["low", "medium", "high"], defaultEffort: "high" }
        : { efforts: ["high", "max"], defaultEffort: "high" }
    : undefined;
  const models: Record<string, unknown> = {
    [modelAlias]: {
      provider: providerAlias,
      model: modelAlias,
      supportsTools: true,
      maxOutputTokens: typeof legacy.maxOutputTokens === "number" ? legacy.maxOutputTokens : undefined,
      thinking: thinkingCapability
    }
  };

  if (legacy.provider === "deepseek") {
    models["deepseek-v4-flash"] ??= {
      provider: providerAlias,
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      supportsTools: true,
      thinking: undefined
    };
    models["deepseek-v4-pro"] ??= {
      provider: providerAlias,
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      supportsTools: true,
      thinking: { efforts: ["low", "medium", "high"], defaultEffort: "high" }
    };
  }

  const legacyReasoning = isRecord(legacy.reasoning) ? legacy.reasoning : undefined;
  const thinking = legacy.provider === "deepseek" && thinkingCapability
    ? {
      enabled: typeof legacyReasoning?.enabled === "boolean" ? legacyReasoning.enabled : true,
      effort: legacyReasoning?.effort === "max" ? "max" : "high"
    }
    : { enabled: false, effort: "high" };
  const { model: _legacyModel, ...rest } = value;
  return {
    ...rest,
    defaultModel: modelAlias,
    providers: { [providerAlias]: provider },
    models,
    thinking
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
