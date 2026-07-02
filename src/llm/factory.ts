/**
 * LLM provider 工厂模块。
 *
 * 运行时从指定环境变量读取 API key，再创建 OpenAI 兼容 provider。这样密钥不会进入
 * 配置文件，也不会散落在命令实现里。
 */
import type { AgentConfig } from "../config/schema.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./provider.js";

export function createLLMProvider(config: AgentConfig): LLMProvider {
  // API key 只从环境变量读取，不写入配置文件，减少误提交风险。
  const apiKey = process.env[config.model.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`No model available. Set ${config.model.apiKeyEnv} in your environment.`);
  }

  // deepseek 与 openai-compatible 共享同一个 HTTP provider，只是 baseUrl/model 不同。
  return new OpenAICompatibleProvider({
    baseUrl: config.model.baseUrl,
    model: config.model.model,
    apiKey
  });
}
