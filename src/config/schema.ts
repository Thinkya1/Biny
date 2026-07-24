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
  allowTools: z.array(z.string()).default(["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search"]),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([".env", ".env.local", ".ssh/", "node_modules/"]),
  criticalAlwaysAsk: z.boolean().default(true)
}).default({
  mode: "ask",
  allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search"],
  allowPaths: [],
  denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
  criticalAlwaysAsk: true
});

const contextSchema = z.object({
  maxInputTokens: z.number().int().min(2_048).max(65_536).default(24_000),
  instructionsMaxBytes: z.number().int().min(1_024).max(131_072).default(32 * 1024),
  memory: z.object({
    enabled: z.boolean().default(true)
  }).default({ enabled: true })
}).default({
  maxInputTokens: 24_000,
  instructionsMaxBytes: 32 * 1024,
  memory: { enabled: true }
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
  compatibility: z.object({
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional()
  }).optional()
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
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  stderr: z.enum(["ignore", "inherit", "pipe"]).default("ignore"),
  enabled: z.boolean().default(true)
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
  skills: z.array(z.string().trim().min(1)).max(32).default([".agent/skills"]),
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
    allowedTools: z.array(subagentToolNameSchema).min(1).default([...defaultSubagentAllowedTools])
  }).default({
    enabled: true,
    maxSteps: 16,
    maxOutputTokens: 8_000,
    maxConcurrentSubagents: 2,
    maxPendingSubagents: 16,
    timeoutMs: 300_000,
    model: undefined,
    maxCostUsd: undefined,
    allowedTools: [...defaultSubagentAllowedTools]
  })
}).default({
  mcp: {},
  skills: [".agent/skills"],
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
    allowedTools: [...defaultSubagentAllowedTools]
  }
});

const webSearchSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["duckduckgo", "brave", "anysearch"]).default("anysearch"),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
  maxResults: z.number().int().min(1).max(10).default(5)
}).default({
  enabled: true,
  provider: "duckduckgo",
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
});

const webSchema = z.object({
  search: webSearchSchema
}).default({
  search: {
    enabled: true,
    provider: "anysearch",
    apiKeyEnv: undefined,
    timeoutMs: 10_000,
    maxResults: 5
  }
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
  if (config.thinking.enabled && activeReasoning === undefined) {
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
  if (config.thinking.enabled && activeReasoning && !activeReasoning.efforts.includes(config.thinking.effort)) {
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
export type ModelReasoningConfig = z.infer<typeof thinkingSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ExtensionsConfig = z.infer<typeof extensionsSchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
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
      capabilities: { tools: true, reasoning: true, streaming: true },
      contextWindow: 128_000,
      thinking: { efforts: ["high", "max"], defaultEffort: "high", mapping: { high: "high", max: "max" }, budgetTokens: { high: 4_096, max: 8_192 } }
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "Frontier model for complex coding, research, and real-world work.",
      supportsTools: true,
      capabilities: { tools: true, reasoning: true, streaming: true },
      contextWindow: 128_000,
      thinking: { efforts: ["high", "max"], defaultEffort: "high", mapping: { high: "high", max: "max" }, budgetTokens: { high: 4_096, max: 8_192 } }
    }
  },
  thinking: { enabled: true, effort: "high" },
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
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff", "web_search"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    ignore: defaultWorkspaceIgnore
  },
  context: {
    maxInputTokens: 24_000,
    instructionsMaxBytes: 32 * 1024,
    memory: { enabled: true }
  },
  web: {
    search: {
      enabled: true,
      provider: "anysearch",
      apiKeyEnv: undefined,
      timeoutMs: 10_000,
      maxResults: 5
    }
  },
  telemetry: { enabled: true, recordInputs: false, recordOutputs: false },
  extensions: {
    mcp: {},
    skills: [".agent/skills"],
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
      allowedTools: [...defaultSubagentAllowedTools]
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
    ? { efforts: ["high", "max"], defaultEffort: "high" }
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
      thinking: thinkingCapability
    };
    models["deepseek-v4-pro"] ??= {
      provider: providerAlias,
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      supportsTools: true,
      thinking: thinkingCapability
    };
  }

  const legacyReasoning = isRecord(legacy.reasoning) ? legacy.reasoning : undefined;
  const thinking = legacy.provider === "deepseek"
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
