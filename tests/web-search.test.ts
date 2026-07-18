import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { createWebSearchTool, parseDuckDuckGoResults } from "../src/tools/web/search.js";

async function main(): Promise<void> {
  testDuckDuckGoParser();
  await testDuckDuckGoSearch();
  await testBraveSearch();
  await testAnySearch();
  testWebSearchPermission();
  testWebSearchRegistration();
}

function testDuckDuckGoParser(): void {
  const results = parseDuckDuckGoResults(`
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=test">Example &amp; result</a>
    </h2>
    <a class="result__snippet" href="/">A <b>useful</b> summary.</a>
  `, 5);

  assert.deepEqual(results, [{
    title: "Example & result",
    url: "https://example.com/",
    snippet: "A useful summary."
  }]);
}

async function testDuckDuckGoSearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    requestedUrl = new URL(String(input));
    return new Response(`
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.gov%2Fchicago&amp;rut=one">Chicago Weather</a></h2>
      <a class="result__snippet" href="/">Official <b>forecast</b> source.</a>
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fweather&amp;rut=two">Example Forecast</a></h2>
      <a class="result__snippet" href="/">A second result.</a>
    `, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    const config = configSchema.parse({
      ...defaultConfig,
      web: {
        search: {
          ...defaultConfig.web.search,
          provider: "duckduckgo",
          maxResults: 3,
          timeoutMs: 1_000
        }
      }
    });
    const tool = createWebSearchTool(config.web.search);
    const execution = await tool.resolveExecution({ query: "Chicago weather", maxResults: 2, domains: ["weather.gov"], recency: "day" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-1", signal: undefined });

    assert.equal(result.query, "Chicago weather");
    assert.equal(result.provider, "duckduckgo");
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]?.url, "https://weather.gov/chicago");
    assert.equal(requestedUrl?.searchParams.get("df"), "d");
    assert.match(requestedUrl?.searchParams.get("q") ?? "", /site:weather\.gov/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBraveSearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BINY_TEST_BRAVE_KEY;
  process.env.BINY_TEST_BRAVE_KEY = "test-key";
  let requestedHeaders: Headers | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "A result from Brave." }] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "brave",
      apiKeyEnv: "BINY_TEST_BRAVE_KEY",
      timeoutMs: 1_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "Biny" });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-2", signal: undefined });
    assert.equal(result.results[0]?.title, "Brave result");
    assert.equal(requestedHeaders?.get("x-subscription-token"), "test-key");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BINY_TEST_BRAVE_KEY;
    else process.env.BINY_TEST_BRAVE_KEY = originalKey;
  }
}

async function testAnySearch(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BINY_TEST_ANYSEARCH_KEY;
  process.env.BINY_TEST_ANYSEARCH_KEY = "test-key";
  let requestedUrl: URL | undefined;
  let requestedMethod: string | undefined;
  let requestedHeaders: Headers | undefined;
  let requestedBody: { query?: string; max_results?: number } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrl = new URL(String(input));
    requestedMethod = init?.method;
    requestedHeaders = new Headers(init?.headers);
    requestedBody = JSON.parse(String(init?.body)) as { query?: string; max_results?: number };
    return new Response(JSON.stringify({
      code: 0,
      message: "success",
      data: {
        results: [{
          title: "AnySearch result",
          url: "https://example.com/anysearch",
          snippet: "A result from AnySearch.",
          content: "The full content is intentionally ignored by web_search."
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const tool = createWebSearchTool({
      enabled: true,
      provider: "anysearch",
      apiKeyEnv: "BINY_TEST_ANYSEARCH_KEY",
      timeoutMs: 1_000,
      maxResults: 5
    });
    const execution = await tool.resolveExecution({ query: "Biny", maxResults: 2, domains: ["example.com"] });
    assert.equal("isError" in execution, false);
    if ("isError" in execution) return;
    const result = await execution.execute({ toolCallId: "search-3", signal: undefined });
    assert.equal(result.provider, "anysearch");
    assert.equal(result.results[0]?.title, "AnySearch result");
    assert.equal(result.results[0]?.snippet, "A result from AnySearch.");
    assert.equal(requestedUrl?.toString(), "https://api.anysearch.com/v1/search");
    assert.equal(requestedMethod, "POST");
    assert.equal(requestedHeaders?.get("authorization"), "Bearer test-key");
    assert.equal(requestedBody?.max_results, 2);
    assert.match(requestedBody?.query ?? "", /site:example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BINY_TEST_ANYSEARCH_KEY;
    else process.env.BINY_TEST_ANYSEARCH_KEY = originalKey;
  }
}

function testWebSearchPermission(): void {
  const request = analyzePermissionRequest({
    toolName: "web_search",
    args: { query: "Chicago weather" },
    sessionId: "test",
    projectRoot: "/tmp"
  });
  assert.equal(request.actionType, "read");
  assert.equal(request.riskLevel, "low");
}

function testWebSearchRegistration(): void {
  const registry = createToolRegistry({ workspaceRoot: "/tmp", ignore: [] }, defaultConfig.web.search);
  assert.equal(registry.get("web_search").name, "web_search");

  const disabledRegistry = createToolRegistry({ workspaceRoot: "/tmp", ignore: [] }, {
    ...defaultConfig.web.search,
    enabled: false
  });
  assert.throws(() => disabledRegistry.get("web_search"), /Unknown tool: web_search/);
}

await main();
