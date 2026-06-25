/**
 * 配置结构模块。
 *
 * `agent.config.json` 的合法形状、默认 mock 配置和 DeepSeek 示例配置都定义在这里。
 * 运行时只接受通过 schema 校验的配置，确保模型 provider、权限模式和 workspace ignore
 * 规则在各入口中保持一致。
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

// 运行时配置的唯一校验入口；loader 读到 JSON 后必须先经过这个 schema。
export const configSchema = z.object({
  model: z.object({
    provider: z.enum(["mock", "openai-compatible", "deepseek"]),
    baseUrl: z.string(),
    model: z.string(),
    apiKeyEnv: z.string()
  }),
  permission: permissionSchema,
  workspace: z.object({
    ignore: z.array(z.string())
  })
});

export type AgentConfig = z.infer<typeof configSchema>;

export const deepSeekConfig: AgentConfig = {
  // deepseek 配置作为示例预设保留，用户可以复制到 agent.config.json 后启用。
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY"
  },
  permission: {
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    ignore: [
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
    ]
  }
};

export const defaultConfig: AgentConfig = {
  // 默认使用 mock，保证首次安装后没有 API key 也能跑通 CLI 和工具链。
  model: {
    provider: "mock",
    baseUrl: "",
    model: "mock",
    apiKeyEnv: "OPENAI_API_KEY"
  },
  permission: {
    mode: "ask",
    allowTools: ["read_file", "list_files", "search_files", "grep_search", "git_status", "git_diff"],
    allowPaths: [],
    denyPaths: [".env", ".env.local", ".ssh/", "node_modules/"],
    criticalAlwaysAsk: true
  },
  workspace: {
    // ignore 同时用于 ProjectContext、文件扫描和搜索工具，避免读取依赖目录、构建产物和本地私有文档。
    ignore: [
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
    ]
  }
};
