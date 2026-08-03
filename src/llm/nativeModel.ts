/**
 * 原生模型入口。
 *
 * 模型实例只负责把统一上下文交给选定的 API Adapter；各协议的 HTTP、SSE 和事件状态机
 * 位于 apiAdapters 目录，Provider 行为由上层运行时准备。
 */
import type { AgentModel } from "../agent/core/types.js";
import type { ModelApiBackend } from "../config/schema.js";
import { ApiAdapterRegistry, type ApiAdapterRequest } from "./ApiAdapterRegistry.js";
import { anthropicMessagesAdapter } from "./apiAdapters/anthropicMessages.js";
import { openAiChatAdapter } from "./apiAdapters/openAiChat.js";
import { openAiResponsesAdapter } from "./apiAdapters/openAiResponses.js";
import { googleGenerativeAiAdapter } from "./apiAdapters/googleGenerativeAi.js";
import { contextOverflowMarker, contextOverflowPattern } from "./apiAdapters/shared.js";

export interface NativeModelConfig {
  provider: string;
  modelId: string;
  api: ModelApiBackend;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  supportsTools?: boolean;
  anthropicAuthMode?: "api-key" | "bearer";
  reasoningProtocol?: "deepseek" | "openai" | "google" | "anthropic" | "alibaba" | "moonshotai";
  providerOptions?: Record<string, unknown>;
  apiAdapters?: ApiAdapterRegistry;
}

export function isModelContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(contextOverflowMarker) || contextOverflowPattern.test(message);
}

export function createNativeModel(config: NativeModelConfig): AgentModel {
  const fetcher = config.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("This runtime does not provide fetch().");
  const adapter = (config.apiAdapters ?? nativeApiAdapters).require(config.api);
  const request: ApiAdapterRequest = { ...config, fetch: fetcher };
  return {
    provider: config.provider,
    modelId: config.modelId,
    supportsTools: config.supportsTools !== false,
    stream: async (context, options) => adapter.stream(request, context, options)
  };
}

export function createNativeApiAdapterRegistry(): ApiAdapterRegistry {
  return new ApiAdapterRegistry([openAiChatAdapter, openAiResponsesAdapter, anthropicMessagesAdapter, googleGenerativeAiAdapter]);
}

const nativeApiAdapters = createNativeApiAdapterRegistry();
