import { z } from "zod";

export const configSchema = z.object({
  model: z.object({
    provider: z.enum(["mock", "openai-compatible"]),
    baseUrl: z.string(),
    model: z.string(),
    apiKeyEnv: z.string()
  }),
  permission: z.object({
    mode: z.enum(["safe"])
  }),
  workspace: z.object({
    ignore: z.array(z.string())
  })
});

export type AgentConfig = z.infer<typeof configSchema>;

export const defaultConfig: AgentConfig = {
  model: {
    provider: "mock",
    baseUrl: "",
    model: "mock",
    apiKeyEnv: "OPENAI_API_KEY"
  },
  permission: {
    mode: "safe"
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
