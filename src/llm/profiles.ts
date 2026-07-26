/**
 * provider profile 兼容层。
 *
 * provider 定义已经统一收到 `src/ai`，这里只保留旧调用方使用的类型别名和转发函数，
 * 新代码请直接用 `providerDefinition`。
 */
import type { ModelProvider } from "../config/schema.js";
import { providerDefinition } from "../ai/provider.js";
import type { ProviderDefinition } from "../ai/types.js";

/** @deprecated 新接入请使用 src/ai 的 provider 定义。 */
export type ProviderProtocol = "anthropic" | "openai-compatible";
export type ReasoningProtocol = NonNullable<ProviderDefinition["reasoningProtocol"]>;
export type ProviderProfile = ProviderDefinition;

export function providerProfile(provider: ModelProvider): ProviderProfile {
  return providerDefinition(provider);
}
