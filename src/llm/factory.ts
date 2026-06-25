/**
 * LLM provider 工厂模块。
 *
 * 配置选择 mock 时直接返回本地 provider；选择真实模型时从指定环境变量读取 API key，
 * 再创建 OpenAI 兼容 provider。这样密钥不会进入配置文件，也不会散落在命令实现里。
 */
import type { AgentConfig } from "../config/schema.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./provider.js";

export function createLLMProvider(config: AgentConfig): LLMProvider {
  // mock provider 用于本地开发和无密钥环境，避免启动阶段强依赖外部服务。
  if (config.model.provider === "mock") return new MockProvider();

  // 真实模型的 API key 只从环境变量读取，不写入配置文件，减少误提交风险。
  const apiKey = process.env[config.model.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing model API key. Set ${config.model.apiKeyEnv} in your environment.`);
  }

  // deepseek 与 openai-compatible 共享同一个 HTTP provider，只是 baseUrl/model 不同。
  return new OpenAICompatibleProvider({
    baseUrl: config.model.baseUrl,
    model: config.model.model,
    apiKey
  });
}
