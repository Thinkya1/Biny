/**
 * 公网搜索工具模块。
 *
 * `web_search` 只返回搜索结果标题、链接和摘要，不打开网页、不执行本地命令，也不修改工作区。
 * 默认使用支持匿名额度的 AnySearch API，也支持无需密钥的 DuckDuckGo HTML 搜索和 Brave Search。
 */
import { z } from "zod";
import type { WebSearchConfig } from "../../config/schema.js";
import { ToolAccesses } from "../access.js";
import type { Tool } from "../types.js";

const defaultConfig: WebSearchConfig = {
  enabled: true,
  provider: "duckduckgo",
  apiKeyEnv: undefined,
  timeoutMs: 10_000,
  maxResults: 5
};

const recencyValues = ["day", "week", "month", "year"] as const;
type SearchRecency = (typeof recencyValues)[number];

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
  domains?: string[];
  recency?: SearchRecency;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchConfig["provider"];
  results: WebSearchResult[];
  fetchedAt: string;
}

export function createWebSearchTool(config?: WebSearchConfig): Tool<WebSearchArgs, WebSearchResponse> {
  const resolvedConfig = config ?? defaultConfig;
  return {
    name: "web_search",
    description: "Search the public web and return relevant result links and snippets. Use this for current information, research, news, weather, or facts outside the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query written in natural language." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, description: "Maximum number of results to return." },
        domains: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 }, description: "Optional domains to restrict the search to, such as weather.gov." },
        recency: { type: "string", enum: [...recencyValues], description: "Optional freshness filter: day, week, month, or year." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().positive().max(10).optional(),
      domains: z.array(z.string().min(1)).max(5).optional(),
      recency: z.enum(recencyValues).optional()
    }),
    capability: "web.search",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: args.query, detail: args },
        description: `Search the public web for ${args.query}`,
        approvalRule: `web_search(${args.query})`,
        async execute({ signal, onUpdate }) {
          onUpdate?.({ kind: "status", text: "Searching the web" });
          const result = await searchWeb(resolvedConfig, args, signal);
          onUpdate?.({ kind: "status", text: `Found ${String(result.results.length)} result(s)` });
          return result;
        }
      };
    }
  };
}

async function searchWeb(config: WebSearchConfig, args: WebSearchArgs, signal: AbortSignal | undefined): Promise<WebSearchResponse> {
  const query = args.query.trim();
  if (!query) throw new Error("web_search requires a non-empty query.");

  const domains = normalizeDomains(args.domains);
  const maxResults = Math.min(args.maxResults ?? config.maxResults, config.maxResults);
  const searchQuery = buildSearchQuery(query, domains);
  const results = config.provider === "anysearch"
    ? await searchWithAnySearch(config, searchQuery, maxResults, signal)
    : config.provider === "brave"
      ? await searchWithBrave(config, searchQuery, maxResults, args.recency, signal)
      : await searchWithDuckDuckGo(config, searchQuery, maxResults, args.recency, signal);

  return {
    query,
    provider: config.provider,
    results,
    fetchedAt: new Date().toISOString()
  };
}

async function searchWithDuckDuckGo(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const freshness = duckDuckGoFreshness(recency);
  url.searchParams.set("df", freshness);
  const html = await fetchText(url, { "accept": "text/html", "user-agent": "Biny web_search" }, config.timeoutMs, signal);
  return parseDuckDuckGoResults(html, maxResults);
}

async function searchWithBrave(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  recency: SearchRecency | undefined,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (!apiKey) {
    const envName = config.apiKeyEnv ?? "BRAVE_SEARCH_API_KEY";
    throw new Error(`Brave web search requires the ${envName} environment variable.`);
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const freshness = braveFreshness(recency);
  if (freshness !== undefined) url.searchParams.set("freshness", freshness);
  const body = await fetchText(url, {
    "accept": "application/json",
    "x-subscription-token": apiKey,
    "user-agent": "Biny web_search"
  }, config.timeoutMs, signal);

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Brave web search returned invalid JSON.");
  }
  return parseBraveResults(payload, maxResults);
}

async function searchWithAnySearch(
  config: WebSearchConfig,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined
): Promise<WebSearchResult[]> {
  const envName = config.apiKeyEnv ?? "ANYSEARCH_API_KEY";
  const apiKey = process.env[envName];
  if (config.apiKeyEnv && !apiKey) {
    throw new Error(`AnySearch web search requires the ${envName} environment variable.`);
  }

  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "user-agent": "Biny web_search"
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const url = new URL("https://api.anysearch.com/v1/search");
  const body = await fetchText(url, headers, config.timeoutMs, signal, {
    method: "POST",
    body: JSON.stringify({ query, max_results: maxResults })
  });

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("AnySearch web search returned invalid JSON.");
  }
  return parseAnySearchResults(payload, maxResults);
}

export function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const resultLinkPattern = /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while (results.length < maxResults && (match = resultLinkPattern.exec(html)) !== null) {
    const rawUrl = match[2] ?? "";
    const title = cleanHtmlText(match[3] ?? "");
    const url = resolveSearchUrl(rawUrl);
    if (!title || !url || seenUrls.has(url)) continue;

    const nextResultIndex = html.indexOf("result__a", resultLinkPattern.lastIndex);
    const segment = html.slice(resultLinkPattern.lastIndex, nextResultIndex < 0 ? undefined : nextResultIndex);
    const snippetMatch = segment.match(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = cleanHtmlText(snippetMatch?.[1] ?? "");
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined });
  }

  return results;
}

function parseBraveResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results)) return [];
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of payload.web.results) {
    if (results.length >= maxResults || !isRecord(item)) break;
    const title = typeof item.title === "string" ? cleanHtmlText(item.title) : "";
    const url = typeof item.url === "string" ? resolveSearchUrl(item.url) : undefined;
    const snippet = typeof item.description === "string" ? cleanHtmlText(item.description) : "";
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

export function parseAnySearchResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload)) throw new Error("AnySearch web search returned an invalid response.");
  if (payload.code !== 0) {
    const message = typeof payload.message === "string" ? payload.message : "request failed";
    throw new Error(`AnySearch web search failed: ${message}`);
  }
  if (!isRecord(payload.data) || !Array.isArray(payload.data.results)) {
    throw new Error("AnySearch web search returned an invalid response.");
  }

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of payload.data.results) {
    if (results.length >= maxResults || !isRecord(item)) break;
    const title = typeof item.title === "string" ? cleanHtmlText(item.title) : "";
    const url = typeof item.url === "string" ? resolveSearchUrl(item.url) : undefined;
    const snippet = typeof item.snippet === "string" ? cleanHtmlText(item.snippet) : "";
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

async function fetchText(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  init: Pick<RequestInit, "method" | "body"> | undefined = undefined
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, {
      method: init?.method,
      body: init?.body,
      headers,
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 180);
      throw new Error(`Web search provider returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    return body;
  } catch (error) {
    if (timedOut) throw new Error(`Web search timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function buildSearchQuery(query: string, domains: string[]): string {
  return domains.length ? `${query} ${domains.map((domain) => `site:${domain}`).join(" ")}` : query;
}

function normalizeDomains(domains: string[] | undefined): string[] {
  if (domains === undefined) return [];
  return domains.map((domain) => {
    const normalized = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/u, "");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(normalized)) {
      throw new Error(`Invalid web search domain: ${domain}`);
    }
    return normalized.toLowerCase();
  });
}

function duckDuckGoFreshness(recency: SearchRecency | undefined): string {
  if (recency === "day") return "d";
  if (recency === "week") return "w";
  if (recency === "month") return "m";
  if (recency === "year") return "y";
  return "";
}

function braveFreshness(recency: SearchRecency | undefined): string | undefined {
  if (recency === "day") return "pd";
  if (recency === "week") return "pw";
  if (recency === "month") return "pm";
  if (recency === "year") return "py";
  return undefined;
}

function resolveSearchUrl(rawUrl: string): string | undefined {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  try {
    const parsed = new URL(decoded, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    const candidate = redirected ? new URL(redirected) : parsed;
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return undefined;
    return candidate.toString();
  } catch {
    return undefined;
  }
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 800);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const numeric = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
