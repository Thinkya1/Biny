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
    ignore: ["node_modules", ".git", "dist", "build", ".env"]
  }
};
