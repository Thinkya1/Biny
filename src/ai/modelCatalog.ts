/**
 * 模型目录拉取与解析。
 *
 * 各服务商的 `/models` 响应字段命名很不统一（下划线/驼峰、context_window/context_length
 * 等），这里把它们归一成 `ModelCatalogEntry`。解析对未知字段一律宽容：识别不了就留空，
 * 不抛错，避免一个模型的异常字段导致整份目录不可用。
 *
 * 这里只读取凭据用于请求，不写配置、不落盘 key。
 */
import type { ModelApiBackend, ModelCompatibility, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";
import { inferReasoningEfforts } from "./capabilities.js";
import { providerProtocol } from "./provider.js";
import { createRetryFetch } from "./retry.js";
import type { CatalogProviderRequest, ModelCatalogEntry } from "./types.js";

const catalogTimeoutMs = 15_000;

export interface ModelCatalogValidators {
  etag?: string;
  lastModified?: number;
}

export interface ModelCatalogFetchResult {
  models?: ModelCatalogEntry[];
  notModified: boolean;
  etag?: string;
  lastModified?: number;
}

/** 拉取服务商的实时模型列表；只读，不写入任何凭据或配置。 */
export async function fetchModelCatalog(request: CatalogProviderRequest, signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
  return (await fetchModelCatalogSnapshot(request, signal)).models ?? [];
}

/** 带 HTTP 校验信息拉取目录，Provider Runtime 用它实现跨进程缓存复用。 */
export async function fetchModelCatalogSnapshot(
  request: CatalogProviderRequest,
  signal?: AbortSignal,
  validators: ModelCatalogValidators = {}
): Promise<ModelCatalogFetchResult> {
  const protocol = providerProtocol(request.config, request.definition);
  const endpoint = request.config.modelsEndpoint ?? defaultModelsEndpoint(request.config.baseUrl ?? request.definition.baseUrl, protocol);
  if (!endpoint) throw new Error(`No model catalog endpoint configured for provider ${request.alias}.`);
  // key 的取值顺序：配置里的明文 → 配置指定的环境变量 → provider 定义的默认环境变量。
  const apiKey = request.config.apiKey
    ?? (request.config.apiKeyEnv ? process.env[request.config.apiKeyEnv] : undefined)
    ?? (request.definition.apiKeyEnv ? process.env[request.definition.apiKeyEnv] : undefined);
  if ((request.config.requiresApiKey ?? request.definition.requiresApiKey) && !apiKey) {
    throw new Error(`No credentials available for provider ${request.alias}.`);
  }
  // Anthropic 原生协议用 x-api-key，OAuth 场景和 OpenAI 兼容端点用 Bearer。
  const authMode = request.config.authMode ?? request.definition.authModes[0];
  const headers: Record<string, string> = protocol === "anthropic" && authMode !== "oauth-bearer"
    ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
    : { Authorization: apiKey ? `Bearer ${apiKey}` : "" };
  if (protocol === "anthropic" && authMode === "oauth-bearer") headers["anthropic-version"] = "2023-06-01";
  Object.assign(headers, request.config.headers);
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified) headers["If-Modified-Since"] = new Date(validators.lastModified).toUTCString();
  const retry = request.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const timeoutSignal = AbortSignal.timeout(catalogTimeoutMs);
  const response = await createRetryFetch(retry)(endpoint, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  });
  const responseValidators = {
    etag: response.headers.get("etag") ?? validators.etag,
    lastModified: httpTimestamp(response.headers.get("last-modified")) ?? validators.lastModified
  };
  if (response.status === 304) return { notModified: true, ...responseValidators };
  if (!response.ok) throw new Error(`Model catalog request failed (${String(response.status)}).`);
  const body = await response.json() as unknown;
  return { models: parseModelCatalog(body, request.alias, protocol), notModified: false, ...responseValidators };
}

/**
 * 解析 `/models` 响应。响应体或条目形状不符合预期时跳过，不抛错，因此返回空数组既可能是
 * 「没有模型」也可能是「响应不认识」。
 */
export function parseModelCatalog(
  value: unknown,
  provider: string,
  protocol: "anthropic" | "openai-compatible"
): ModelCatalogEntry[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : [];
  // 用 flatMap 而不是 map+filter：无效条目直接返回空数组丢弃。
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id) ?? stringValue(item.model) ?? stringValue(item.name);
    if (!id) return [];
    const contextWindow = numberValue(item.context_window)
      ?? numberValue(item.contextWindow)
      ?? numberValue(item.context_length)
      ?? numberValue(item.contextLength);
    const maxOutputTokens = numberValue(item.max_tokens)
      ?? numberValue(item.maxOutputTokens)
      ?? numberValue(item.max_completion_tokens)
      ?? numberValue(item.maxCompletionTokens);
    const declaredThinkingLevelMap = parseThinkingLevelMap(item.thinkingLevelMap ?? item.thinking_level_map);
    const reasoningEfforts = declaredThinkingLevelMap
      ? Object.keys(declaredThinkingLevelMap)
        .filter((level) => level !== "off" && declaredThinkingLevelMap[level] !== null)
        .filter(isReasoningEffort)
      : Array.isArray(item.reasoning_efforts)
      ? item.reasoning_efforts.filter(isReasoningEffort)
      : Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter(isReasoningEffort)
      : protocol === "anthropic" ? ["high", "max"] as ReasoningEffort[]
      // OpenAI 兼容端点基本不返回推理档位字段，只能按模型 ID 兜底推断，
      // 否则 grok-4.5 / GPT-5 这类模型在界面上只剩一个「默认」档。
      : inferReasoningEfforts(id);
    const modalities = Array.isArray(item.modalities) ? item.modalities : [];
    const entry: ModelCatalogEntry = {
      id,
      displayName: stringValue(item.display_name) ?? stringValue(item.displayName) ?? stringValue(item.name) ?? id,
      provider,
      contextWindow,
      maxOutputTokens,
      capabilities: {
        tools: booleanValue(item.supports_tools) ?? booleanValue(item.supportsTools),
        reasoning: booleanValue(item.supports_reasoning) ?? booleanValue(item.supportsReasoning),
        vision: booleanValue(item.supports_vision) ?? booleanValue(item.supportsVision) ?? modalityCapability(modalities, "image"),
        audio: booleanValue(item.supports_audio) ?? booleanValue(item.supportsAudio) ?? modalityCapability(modalities, "audio"),
        streaming: true
      },
      reasoningEfforts
    };
    const apiBackend = parseApiBackend(item.apiBackend ?? item.api ?? item.endpoint_type);
    const baseUrl = stringValue(item.base_url) ?? stringValue(item.baseUrl);
    const headers = stringRecord(item.headers);
    const compatibility = parseCompatibility(item.compatibility);
    if (declaredThinkingLevelMap) entry.thinkingLevelMap = declaredThinkingLevelMap;
    if (apiBackend) entry.apiBackend = apiBackend;
    if (baseUrl) entry.baseUrl = baseUrl;
    if (headers) entry.headers = headers;
    if (compatibility) entry.compatibility = compatibility;
    return [entry];
  });
}

/** Anthropic 的模型列表在 `/v1/models`，兼容端点的 baseUrl 通常已经带了版本段。 */
function defaultModelsEndpoint(baseUrl: string | undefined, protocol: "anthropic" | "openai-compatible"): string | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/u, "");
  return protocol === "anthropic" && !/\/v1$/u.test(normalized)
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

// 以下取值函数统一策略：类型不对或明显无意义（空串、非正整数）就返回 undefined，
// 交给上层的 `??` 链继续尝试下一个字段名。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;
  const map: ThinkingLevelMap = {};
  for (const [key, native] of Object.entries(value)) {
    if (key !== "off" && !isReasoningEffort(key)) continue;
    if (native === null) map[key] = null;
    else if (typeof native === "string" && native.trim()) map[key] = native;
  }
  return Object.keys(map).length ? map : undefined;
}

function parseApiBackend(value: unknown): ModelApiBackend | undefined {
  if (value === "openai-responses") return "responses";
  if (value === "anthropic-messages") return "anthropic_messages";
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

function parseCompatibility(value: unknown): ModelCompatibility | undefined {
  if (!isRecord(value)) return undefined;
  return {
    supportsDeveloperRole: booleanValue(value.supportsDeveloperRole),
    supportsReasoning: booleanValue(value.supportsReasoning),
    supportsVision: booleanValue(value.supportsVision),
    maxTokensField: value.maxTokensField === "max_tokens" || value.maxTokensField === "max_completion_tokens"
      ? value.maxTokensField
      : undefined
  };
}

/**
 * 只在 modality 出现时返回 true。不返回 false 是故意的：`modalities` 缺项不代表不支持，
 * 返回 undefined 才能让上层继续按默认值处理。
 */
function modalityCapability(modalities: unknown[], modality: string): boolean | undefined {
  return modalities.includes(modality) ? true : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function httpTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
