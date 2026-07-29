/** Claude/OpenAI 订阅登录与模型请求共用的协议常量和请求头。 */
export const CLAUDE_SUBSCRIPTION_BETA = "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219";

export function openAiCodexHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (Biny)"
  };
  const accountId = accessToken ? extractOpenAiAccountId(accessToken) : undefined;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

/**
 * 只读取 JWT payload 中的账号 id，不在客户端做签名验证；真正的鉴权仍由服务端完成。
 */
export function extractOpenAiAccountId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const nested = parsed["https://api.openai.com/auth"];
    if (nested && typeof nested === "object") {
      const accountId = (nested as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === "string" && accountId) return accountId;
    }
    const accountId = parsed.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}
