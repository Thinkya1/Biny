import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { DesktopModelLoginMethod, DesktopModelLoginProvider, DesktopModelLoginStartResult } from "../../protocol.js";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_ENDPOINT = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "user:sessions:claude_code user:mcp_servers user:file_upload";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_CALLBACK_HOST = "127.0.0.1";
const CODEX_CALLBACK_PORT = 1455;
const CLAUDE_SUBSCRIPTION_BETA = "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219";

export interface AuthenticatedModelLogin {
  provider: DesktopModelLoginProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  models: AuthenticatedModel[];
}

export interface AuthenticatedModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

interface BasePendingAuthorization {
  provider: DesktopModelLoginProvider;
  verifier: string;
  state: string;
  createdAt: number;
  url: string;
}

interface ClaudePendingAuthorization extends BasePendingAuthorization {
  provider: "claude-code";
}

interface CodexPendingAuthorization extends BasePendingAuthorization {
  provider: "openai-codex";
  callback: Promise<{ code: string; state: string } | undefined>;
  resolveCallback(value: { code: string; state: string } | undefined): void;
  server: Server;
}

type PendingAuthorization = ClaudePendingAuthorization | CodexPendingAuthorization;

export class DesktopModelLoginService {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly openExternal: (url: string) => Promise<void>) {}

  async start(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult> {
    this.pruneExpired();
    return provider === "claude-code" ? await this.startClaudeAuthorization() : await this.startCodexAuthorization();
  }

  async complete(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<AuthenticatedModelLogin> {
    const pending = this.pending.get(authRequestId);
    if (!pending || pending.provider !== provider) throw new Error("授权会话不存在，请重新点击登录。");
    if (this.isExpired(pending)) {
      this.dispose(authRequestId);
      throw new Error("授权请求已过期，请重新点击登录。");
    }
    if (pending.provider === "claude-code") return await this.completeClaudeAuthorization(authRequestId, pending, pastedAuthorization);
    return await this.completeCodexAuthorization(authRequestId, pending);
  }

  cancel(provider: DesktopModelLoginProvider, authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (pending?.provider === provider) this.dispose(authRequestId);
  }

  async refresh(provider: DesktopModelLoginProvider, tokens: OAuthTokens): Promise<OAuthTokens> {
    if (provider === "claude-code") return await this.refreshClaudeTokens(tokens);
    return await this.refreshCodexTokens(tokens);
  }

  private async startClaudeAuthorization(): Promise<DesktopModelLoginStartResult> {
    const verifier = base64url(randomBytes(32));
    const state = verifier;
    const url = new URL(CLAUDE_AUTHORIZE_ENDPOINT);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
    url.searchParams.set("scope", CLAUDE_SCOPE);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return await this.openAuthorization({
      provider: "claude-code",
      verifier,
      state,
      createdAt: Date.now(),
      url: url.toString()
    }, "paste-code");
  }

  private async startCodexAuthorization(): Promise<DesktopModelLoginStartResult> {
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authRequestId = randomUUID();
    const callback = deferredCallback();
    const server = await startCodexCallbackServer(state, callback.resolve);
    const url = new URL(CODEX_AUTHORIZE_ENDPOINT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CODEX_CLIENT_ID);
    url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "codex_cli_rs");
    const pending: CodexPendingAuthorization = {
      provider: "openai-codex",
      verifier,
      state,
      createdAt: Date.now(),
      url: url.toString(),
      callback: callback.promise,
      resolveCallback: callback.resolve,
      server
    };
    this.pending.set(authRequestId, pending);
    try {
      await this.openExternal(pending.url);
    } catch (error) {
      this.dispose(authRequestId);
      throw new Error(`无法打开浏览器：${safeMessage(error)}`);
    }
    return { authRequestId, stateHint: state.slice(0, 8), method: "browser-callback" };
  }

  private async openAuthorization(pending: ClaudePendingAuthorization, method: DesktopModelLoginMethod): Promise<DesktopModelLoginStartResult> {
    const authRequestId = randomUUID();
    this.pending.set(authRequestId, pending);
    try {
      await this.openExternal(pending.url);
    } catch (error) {
      this.pending.delete(authRequestId);
      throw new Error(`无法打开浏览器：${safeMessage(error)}`);
    }
    return { authRequestId, stateHint: pending.state.slice(0, 8), method };
  }

  private async completeClaudeAuthorization(authRequestId: string, pending: ClaudePendingAuthorization, pastedAuthorization: string | undefined): Promise<AuthenticatedModelLogin> {
    const pasted = parseClaudePastedAuthorization(pastedAuthorization);
    if (!pasted) throw new Error("授权码格式不正确，请粘贴完整的 code#state。");
    if (!constantTimeEqual(pasted.state, pending.state)) throw new Error("授权码 state 校验失败，请重新登录。");
    try {
      const tokens = await this.exchangeClaudeCode(pasted.code, pending.verifier, pasted.state);
      const models = await discoverClaudeModels(tokens.accessToken);
      if (!models.length) throw new Error("Claude 账号没有返回可用模型。");
      return { provider: "claude-code", ...tokens, models };
    } finally {
      this.pending.delete(authRequestId);
    }
  }

  private async completeCodexAuthorization(authRequestId: string, pending: CodexPendingAuthorization): Promise<AuthenticatedModelLogin> {
    try {
      const callback = await pending.callback;
      if (!callback) throw new Error("未收到浏览器授权回调，请重新登录。");
      if (!constantTimeEqual(callback.state, pending.state)) throw new Error("浏览器回调 state 校验失败，请重新登录。");
      const tokens = await this.exchangeCodexCode(callback.code, pending.verifier);
      const models = await discoverCodexModels(tokens.accessToken);
      if (!models.length) throw new Error("ChatGPT 账号没有返回可用 Codex 模型。");
      return { provider: "openai-codex", ...tokens, models };
    } finally {
      this.dispose(authRequestId);
    }
  }

  private async exchangeClaudeCode(code: string, verifier: string, state: string): Promise<OAuthTokens> {
    const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.153 (external, cli)" },
      body: JSON.stringify({
        code,
        state,
        grant_type: "authorization_code",
        client_id: CLAUDE_CLIENT_ID,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier
      })
    });
    if (!response.ok) throw new Error(`Claude 授权码交换失败（HTTP ${String(response.status)}）：${await compactResponse(response)}`);
    return parseOAuthTokens(await response.json(), "Claude");
  }

  private async exchangeCodexCode(code: string, verifier: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI
    });
    const response = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "biny-desktop/0.2.1" },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`Codex 授权码交换失败（HTTP ${String(response.status)}）：${await compactResponse(response)}`);
    const tokens = parseOAuthTokens(await response.json(), "Codex");
    return { ...tokens, accountId: extractOpenAiAccountId(tokens.accessToken) };
  }

  private async refreshClaudeTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
    const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.153 (external, cli)" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: CLAUDE_CLIENT_ID })
    });
    if (!response.ok) throw new Error(`Claude 登录已过期（HTTP ${String(response.status)}），请重新登录。`);
    return mergeRefreshedTokens(tokens, await response.json(), "Claude");
  }

  private async refreshCodexTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: CODEX_CLIENT_ID });
    const response = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "biny-desktop/0.2.1" },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`Codex 登录已过期（HTTP ${String(response.status)}），请重新登录。`);
    const refreshed = mergeRefreshedTokens(tokens, await response.json(), "Codex");
    return { ...refreshed, accountId: extractOpenAiAccountId(refreshed.accessToken) ?? tokens.accountId };
  }

  private isExpired(pending: PendingAuthorization): boolean {
    return Date.now() - pending.createdAt > AUTHORIZATION_TTL_MS;
  }

  private pruneExpired(): void {
    for (const [authRequestId, pending] of this.pending) {
      if (this.isExpired(pending)) this.dispose(authRequestId);
    }
  }

  private dispose(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    this.pending.delete(authRequestId);
    if (pending.provider === "openai-codex") {
      pending.resolveCallback(undefined);
      pending.server.closeAllConnections?.();
      pending.server.close();
    }
  }
}

async function discoverClaudeModels(accessToken: string): Promise<AuthenticatedModel[]> {
  const response = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "claude-cli/2.1.153 (external, cli)",
      "anthropic-beta": CLAUDE_SUBSCRIPTION_BETA,
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli"
    }
  });
  if (!response.ok) throw new Error(`无法读取 Claude 可用模型（HTTP ${String(response.status)}）。`);
  const payload = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown }> };
  return (payload.data ?? []).flatMap((model) => typeof model.id === "string" && model.id.startsWith("claude-")
    ? [{ id: model.id, displayName: typeof model.display_name === "string" ? model.display_name : formatModelName(model.id), supportsThinking: true }]
    : []);
}

async function discoverCodexModels(accessToken: string): Promise<AuthenticatedModel[]> {
  const response = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...openAiCodexHeaders(accessToken),
      "content-type": "application/json"
    }
  });
  if (!response.ok) throw new Error(`无法读取 Codex 可用模型（HTTP ${String(response.status)}）。`);
  const payload = await response.json() as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
  return (payload.models ?? []).flatMap((model) => {
    if (typeof model.slug !== "string" || !model.slug.trim()) return [];
    const visibility = typeof model.visibility === "string" ? model.visibility.toLowerCase() : "";
    if (visibility === "hide" || visibility === "hidden") return [];
    return [{ id: model.slug.trim(), displayName: formatModelName(model.slug.trim()), supportsThinking: true }];
  });
}

function parseClaudePastedAuthorization(value: string | undefined): { code: string; state: string } | undefined {
  if (!value) return undefined;
  const pasted = value.trim();
  const divider = pasted.indexOf("#");
  if (divider <= 0 || divider === pasted.length - 1 || pasted.indexOf("#", divider + 1) !== -1) return undefined;
  const code = pasted.slice(0, divider);
  const state = pasted.slice(divider + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(code) || !/^[A-Za-z0-9_-]+$/.test(state)) return undefined;
  return { code, state };
}

function parseOAuthTokens(payload: unknown, provider: string): OAuthTokens {
  if (!payload || typeof payload !== "object") throw new Error(`${provider} 返回了无效的授权信息。`);
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`${provider} 返回了不完整的授权信息。`);
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1_000 };
}

function mergeRefreshedTokens(previous: OAuthTokens, payload: unknown, provider: string): OAuthTokens {
  const refreshed = parseOAuthTokens(payload, provider);
  const record = payload as Record<string, unknown>;
  return {
    ...refreshed,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : previous.refreshToken,
    accountId: previous.accountId
  };
}

function openAiCodexHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (Biny)"
  };
  const accountId = extractOpenAiAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function extractOpenAiAccountId(token: string): string | undefined {
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

function formatModelName(modelId: string): string {
  if (/^gpt-/i.test(modelId)) return `GPT-${modelId.slice(4)}`;
  if (/^o[1-9]$/i.test(modelId)) return modelId.toLowerCase();
  return modelId.replace(/(^|[-_])([a-z0-9])/gi, (_match, separator: string, character: string) => `${separator ? " " : ""}${character.toUpperCase()}`);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function deferredCallback(): { promise: Promise<{ code: string; state: string } | undefined>; resolve(value: { code: string; state: string } | undefined): void } {
  let resolve!: (value: { code: string; state: string } | undefined) => void;
  const promise = new Promise<{ code: string; state: string } | undefined>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function startCodexCallbackServer(expectedState: string, resolveCallback: (value: { code: string; state: string } | undefined) => void): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callbackUrl = new URL(request.url ?? "/", `http://${CODEX_CALLBACK_HOST}:${String(CODEX_CALLBACK_PORT)}`);
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");
      if (callbackUrl.pathname !== "/auth/callback" || !code || !state || !constantTimeEqual(state, expectedState)) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<p>授权回调无效，请返回 Biny 重新登录。</p>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<p>登录成功，可以返回 Biny 完成连接。</p>");
      resolveCallback({ code, state });
    });
    const onError = (error: Error): void => reject(new Error(`无法启动 Codex 本地回调：${safeMessage(error)}`));
    server.once("error", onError);
    server.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function compactResponse(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : "服务商未返回错误详情";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
