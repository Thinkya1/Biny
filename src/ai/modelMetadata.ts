/**
 * models.dev 生成快照的运行时适配层。
 *
 * 快照只提供模型事实和价格；它不能提供请求地址、协议或密钥。后者仍由 Biny 的 provider
 * 定义和配置决定，避免把第三方目录当成可执行 transport 配置。
 */
import {
  GENERATED_MODELS_DEV_CATALOG_PROVIDERS,
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_PROVIDER_ALIASES
} from "./modelMetadata.generated.js";
import type { ModelCapabilities, ModelCatalogEntry } from "./types.js";
import type { ModelPricing, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";

export interface ModelMetadata {
  displayName: string;
  description?: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  capabilities: Partial<ModelCapabilities>;
  reasoningEfforts: ReasoningEffort[];
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  modalities?: {
    input: string[];
    output: string[];
  };
  pricing?: ModelPricing;
}

export const generatedModelProviderTypes = [...GENERATED_MODELS_DEV_CATALOG_PROVIDERS];

/** 按 models.dev 快照的 access-path 别名查找模型事实。 */
export function lookupModelMetadata(providerType: string, modelId: string): ModelMetadata | undefined {
  const provider = generatedProviderType(providerType);
  return GENERATED_MODELS_DEV_METADATA[provider]?.[modelId.trim()];
}

/** 返回适合 Biny tool agent 的离线模型目录；无 tool_call 声明的模型只保留为显式配置元数据。 */
export function generatedProviderModels(providerType: string): ModelCatalogEntry[] {
  if (!GENERATED_MODELS_DEV_CATALOG_PROVIDERS.includes(providerType)) return [];
  const provider = generatedProviderType(providerType);
  return Object.entries(GENERATED_MODELS_DEV_METADATA[provider] ?? {})
    .filter(([, metadata]) => metadata.capabilities.tools === true)
    .map(([id, metadata]) => metadataToCatalogEntry(id, metadata, providerType));
}

function generatedProviderType(providerType: string): string {
  let current = providerType;
  const visited = new Set<string>();
  while (GENERATED_MODELS_DEV_PROVIDER_ALIASES[current] && !visited.has(current)) {
    visited.add(current);
    current = GENERATED_MODELS_DEV_PROVIDER_ALIASES[current]!;
  }
  return current;
}

function metadataToCatalogEntry(id: string, metadata: ModelMetadata, provider: string): ModelCatalogEntry {
  return {
    id,
    displayName: metadata.displayName,
    provider,
    description: metadata.description,
    contextWindow: metadata.contextWindow,
    maxInputTokens: metadata.maxInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    capabilities: { ...metadata.capabilities },
    reasoningEfforts: [...metadata.reasoningEfforts],
    thinkingLevelMap: metadata.reasoningEfforts.length ? thinkingLevelMapForEfforts(metadata.reasoningEfforts) : undefined,
    pricing: metadata.pricing ? { ...metadata.pricing } : undefined
  };
}

function thinkingLevelMapForEfforts(efforts: ReasoningEffort[]): ThinkingLevelMap {
  return {
    off: "none",
    ...Object.fromEntries(efforts.map((effort) => [effort, effort]))
  };
}
