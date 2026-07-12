/**
 * Runtime configuration schema.
 *
 * Providers own credentials and endpoints, while model aliases own model IDs and
 * capabilities. The legacy single `model` object is migrated at the parse boundary.
 */
import { z } from "zod";

const permissionSchema = z.object({
  mode: z.enum(["safe", "ask", "read-only", "auto", "full-access"]).default("ask"),
  allowTools: z.array(z.string()).default(["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff"]),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([".env", ".env.local", ".ssh/", "node_modules/"]),
  criticalAlwaysAsk: z.boolean().default(true)
}).default({
  mode: "ask",
  allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff"],
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
  "gemini",
  "kimi",
  "qwen",
  "ollama",
  "openai-compatible"
]);

export const reasoningEffortSchema = z.enum(["high", "max"]);

const thinkingSchema = z.object({
  enabled: z.boolean().default(true),
  effort: reasoningEffortSchema.default("high")
}).default({ enabled: true, effort: "high" });

const providerConfigSchema = z.object({
  type: modelProviderSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional()
}).superRefine((provider, context) => {
  if (provider.type === "openai-compatible" && !provider.baseUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "openai-compatible requires a provider baseUrl."
    });
  }
});

const modelThinkingSchema = z.object({
  efforts: z.array(reasoningEffortSchema).min(1).default(["high", "max"]),
  defaultEffort: reasoningEffortSchema.default("high")
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
  maxOutputTokens: z.number().int().min(1).max(131_072).optional(),
  thinking: modelThinkingSchema.optional()
});

const canonicalConfigSchema = z.object({
  defaultModel: z.string().min(1),
  providers: z.record(providerConfigSchema),
  models: z.record(modelAliasSchema),
  thinking: thinkingSchema,
  permission: permissionSchema,
  workspace: z.object({
    ignore: z.array(z.string())
  }),
  context: contextSchema
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
    if (model.thinking !== undefined && provider.type !== "deepseek") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", alias, "thinking"],
        message: "Thinking controls are currently supported only by DeepSeek providers."
      });
    }
  }

  if (config.thinking.enabled && activeModel?.thinking === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "enabled"],
      message: `Model ${config.defaultModel} does not support thinking controls.`
    });
  }
  if (config.thinking.enabled && activeModel?.thinking && !activeModel.thinking.efforts.includes(config.thinking.effort)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinking", "effort"],
      message: `Model ${config.defaultModel} does not support ${config.thinking.effort} effort.`
    });
  }
});

export const configSchema = z.preprocess(migrateLegacyConfig, canonicalConfigSchema);

export type AgentConfig = z.infer<typeof canonicalConfigSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelAliasConfig = z.infer<typeof modelAliasSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelReasoningConfig = z.infer<typeof thinkingSchema>;

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
      thinking: { efforts: ["high", "max"], defaultEffort: "high" }
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      thinking: { efforts: ["high", "max"], defaultEffort: "high" }
    }
  },
  thinking: { enabled: true, effort: "high" },
  permission: {
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff"],
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
      maxOutputTokens: typeof legacy.maxOutputTokens === "number" ? legacy.maxOutputTokens : undefined,
      thinking: thinkingCapability
    }
  };

  if (legacy.provider === "deepseek") {
    models["deepseek-v4-flash"] ??= {
      provider: providerAlias,
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      thinking: thinkingCapability
    };
    models["deepseek-v4-pro"] ??= {
      provider: providerAlias,
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
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
