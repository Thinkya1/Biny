import type { ReasoningEffort } from "../config/schema.js";
import { providerProtocol } from "./provider.js";
import { createRetryFetch } from "./retry.js";
import type { CatalogProviderRequest, ModelCatalogEntry } from "./types.js";

const catalogTimeoutMs = 15_000;

/** Fetches the provider's live model list without writing credentials or config. */
export async function fetchModelCatalog(request: CatalogProviderRequest): Promise<ModelCatalogEntry[]> {
  const protocol = providerProtocol(request.config, request.definition);
  const endpoint = request.config.modelsEndpoint ?? defaultModelsEndpoint(request.config.baseUrl ?? request.definition.baseUrl, protocol);
  if (!endpoint) throw new Error(`No model catalog endpoint configured for provider ${request.alias}.`);
  const apiKey = request.config.apiKey
    ?? (request.config.apiKeyEnv ? process.env[request.config.apiKeyEnv] : undefined)
    ?? (request.definition.apiKeyEnv ? process.env[request.definition.apiKeyEnv] : undefined);
  if ((request.config.requiresApiKey ?? request.definition.requiresApiKey) && !apiKey) {
    throw new Error(`No credentials available for provider ${request.alias}.`);
  }
  const authMode = request.config.authMode ?? request.definition.authModes[0];
  const headers: Record<string, string> = protocol === "anthropic" && authMode !== "oauth-bearer"
    ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
    : { Authorization: apiKey ? `Bearer ${apiKey}` : "" };
  if (protocol === "anthropic" && authMode === "oauth-bearer") headers["anthropic-version"] = "2023-06-01";
  const retry = request.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const response = await createRetryFetch(retry)(endpoint, {
    headers,
    signal: AbortSignal.timeout(catalogTimeoutMs)
  });
  if (!response.ok) throw new Error(`Model catalog request failed (${String(response.status)}).`);
  const body = await response.json() as unknown;
  return parseModelCatalog(body, request.alias, protocol);
}

export function parseModelCatalog(
  value: unknown,
  provider: string,
  protocol: "anthropic" | "openai-compatible"
): ModelCatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) return [];
    const contextWindow = numberValue(item.context_window)
      ?? numberValue(item.contextWindow)
      ?? numberValue(item.context_length)
      ?? numberValue(item.contextLength);
    const maxOutputTokens = numberValue(item.max_tokens)
      ?? numberValue(item.maxOutputTokens)
      ?? numberValue(item.max_completion_tokens)
      ?? numberValue(item.maxCompletionTokens);
    const reasoningEfforts = Array.isArray(item.reasoning_efforts)
      ? item.reasoning_efforts.filter(isReasoningEffort)
      : Array.isArray(item.reasoningEfforts)
        ? item.reasoningEfforts.filter(isReasoningEffort)
      : protocol === "anthropic" ? ["high", "max"] as ReasoningEffort[] : [];
    const modalities = Array.isArray(item.modalities) ? item.modalities : [];
    return [{
      id: item.id,
      displayName: stringValue(item.display_name) ?? stringValue(item.name) ?? item.id,
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
    }];
  });
}

function defaultModelsEndpoint(baseUrl: string | undefined, protocol: "anthropic" | "openai-compatible"): string | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/u, "");
  return protocol === "anthropic" && !/\/v1$/u.test(normalized)
    ? `${normalized}/v1/models`
    : `${normalized}/models`;
}

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

function modalityCapability(modalities: unknown[], modality: string): boolean | undefined {
  return modalities.includes(modality) ? true : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
