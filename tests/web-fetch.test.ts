import assert from "node:assert/strict";
import { blockedAddressReason, assertFetchableUrl } from "../src/tools/web/addressPolicy.js";
import { createWebFetchTool, type WebFetchResult } from "../src/tools/web/fetch.js";
import { htmlTitle, htmlToText } from "../src/tools/web/html.js";

async function main(): Promise<void> {
  testBlockedAddressClassification();
  await testUrlPolicyRefusesInternalTargets();
  testHtmlExtraction();
  await testFetchesTextAndPages();
  await testRedirectToInternalTargetIsRefused();
  await testByteLimitTruncatesInsteadOfHanging();
  console.log("web fetch tests passed");
}

/** 私网、环回、云元数据、IPv4-mapped IPv6 都必须被判定为不可抓取。 */
function testBlockedAddressClassification(): void {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"
  ]) {
    assert.equal(typeof blockedAddressReason(address), "string", `${address} must be refused`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
    assert.equal(blockedAddressReason(address), undefined, `${address} must be allowed`);
  }
}

async function testUrlPolicyRefusesInternalTargets(): Promise<void> {
  await assert.rejects(assertFetchableUrl(new URL("http://127.0.0.1:8080/x")), /loopback/);
  await assert.rejects(assertFetchableUrl(new URL("http://169.254.169.254/latest/meta-data/")), /link-local/);
  await assert.rejects(assertFetchableUrl(new URL("file:///etc/passwd")), /http and https/);
  await assert.rejects(assertFetchableUrl(new URL("http://user:pw@example.com/")), /credentials/);
  // 明确开启后才放行本机，用于抓本地开发服务。
  await assertFetchableUrl(new URL("http://127.0.0.1:8080/x"), { allowPrivateNetwork: true });
}

function testHtmlExtraction(): void {
  const html = "<html><head><title>Doc &amp; Guide</title><style>a{}</style></head>"
    + "<body><script>evil()</script><h1>Title</h1><p>First para</p><ul><li>one</li><li>two</li></ul></body></html>";
  const text = htmlToText(html);
  assert.equal(htmlTitle(html), "Doc & Guide");
  assert.equal(text.includes("evil()"), false, "script bodies must not leak into the text");
  assert.equal(text.includes("a{}"), false, "style bodies must not leak into the text");
  assert.equal(text.includes("First para"), true);
  assert.equal(/- one/.test(text), true);
}

async function testFetchesTextAndPages(): Promise<void> {
  const body = "<html><title>T</title><body><p>" + "word ".repeat(200) + "</p></body></html>";
  await withFetch(async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } }), async () => {
    const tool = createWebFetchTool();
    const first = await run(tool, { url: "https://example.com/doc", length: 40 });
    assert.equal(first.status, 200);
    assert.equal(first.title, "T");
    assert.equal(first.content.length, 40);
    assert.equal(first.hasMore, true);
    const second = await run(tool, { url: "https://example.com/doc", offset: 40, length: 40 });
    assert.notEqual(second.content, first.content);
    assert.equal(second.offset, 40);
  });
}

/** 跳转必须逐跳校验：一次跳到元数据地址就能读到云实例凭证。 */
async function testRedirectToInternalTargetIsRefused(): Promise<void> {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith("https://example.com")) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    return new Response("instance credentials", { status: 200, headers: { "content-type": "text/plain" } });
  }, async () => {
    const tool = createWebFetchTool();
    await assert.rejects(run(tool, { url: "https://example.com/redirect" }), /link-local/);
  });
}

/** Content-Length 可以撒谎，收口必须按实际读到的字节数。 */
async function testByteLimitTruncatesInsteadOfHanging(): Promise<void> {
  await withFetch(async () => new Response("x".repeat(50_000), {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "10" }
  }), async () => {
    const tool = createWebFetchTool({ enabled: true, timeoutMs: 5_000, maxBytes: 4_096, maxRedirects: 5, allowPrivateNetwork: false });
    const result = await run(tool, { url: "https://example.com/big", length: 200_000 });
    assert.equal(result.truncatedAtByteLimit, true);
    assert.equal(result.totalCharacters <= 4_096, true, `expected <= 4096 characters, got ${String(result.totalCharacters)}`);
  });
}

async function run(
  tool: ReturnType<typeof createWebFetchTool>,
  args: { url: string; offset?: number; length?: number }
): Promise<WebFetchResult> {
  const execution = await tool.resolveExecution(args);
  if (!("execute" in execution)) throw new Error("web_fetch did not resolve to a runnable execution.");
  return await execution.execute({ toolCallId: "fetch-test" });
}

async function withFetch(handler: typeof fetch | ((input: unknown) => Promise<Response>), body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

await main();
