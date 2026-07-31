/**
 * 统一模型凭据存储。
 *
 * macOS 上 CLI、TUI 和 Electron 都通过 `security` 访问同一个 Keychain service/account；其他平台
 * 不落盘，模型凭据只从配置声明的环境变量读取。凭据值不会进入 IPC、session 或 config.json。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "./schema.js";

const execFileAsync = promisify(execFile);

export const BINY_KEYCHAIN_SERVICE = "com.biny.agent";
export const WEB_SEARCH_CREDENTIAL_ACCOUNT = "web-search:apiKey";

export type ProviderCredentialKind = "apiKey" | "refreshToken";

export interface CredentialStore {
  readonly persistent: boolean;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface KeychainCommandResult {
  stdout: string;
  stderr?: string;
}

export type KeychainCommand = (command: string, args: string[]) => Promise<KeychainCommandResult>;

export class MacKeychainCredentialStore implements CredentialStore {
  readonly persistent = true;

  constructor(
    private readonly run: KeychainCommand = async (command, args) => {
      const result = await execFileAsync(command, args, { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr };
    }
  ) {}

  async get(account: string): Promise<string | undefined> {
    try {
      const result = await this.run("security", ["find-generic-password", "-s", BINY_KEYCHAIN_SERVICE, "-a", account, "-w"]);
      const value = result.stdout.trim();
      return value || undefined;
    } catch (error) {
      if (isKeychainItemMissing(error)) return undefined;
      throw keychainError("读取", account, error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await this.run("security", ["add-generic-password", "-U", "-s", BINY_KEYCHAIN_SERVICE, "-a", account, "-w", value]);
    } catch (error) {
      throw keychainError("保存", account, error);
    }
  }

  async delete(account: string): Promise<void> {
    try {
      await this.run("security", ["delete-generic-password", "-s", BINY_KEYCHAIN_SERVICE, "-a", account]);
    } catch (error) {
      if (isKeychainItemMissing(error)) return;
      throw keychainError("删除", account, error);
    }
  }
}

/** 非 macOS 的显式无持久化实现，避免误把凭据写入一个看似安全但未审计的文件。 */
export class EnvironmentCredentialStore implements CredentialStore {
  readonly persistent = false;

  async get(_account: string): Promise<string | undefined> {
    return undefined;
  }

  async set(_account: string, _value: string): Promise<void> {
    throw new Error("当前平台不支持持久化模型凭据，请改用 providers.<alias>.apiKeyEnv 环境变量。");
  }

  async delete(_account: string): Promise<void> {
    // 环境变量不是由 Biny 管理的，删除操作没有持久化副作用。
  }
}

export function createCredentialStore(platform = process.platform): CredentialStore {
  return platform === "darwin" ? new MacKeychainCredentialStore() : new EnvironmentCredentialStore();
}

export function providerCredentialAccount(providerAlias: string, kind: ProviderCredentialKind): string {
  return `provider:${providerAlias}:${kind}`;
}

export function applyStoredCredentials(config: AgentConfig, store: CredentialStore): Promise<AgentConfig> {
  return loadStoredCredentials(config, store);
}

export async function loadStoredCredentials(config: AgentConfig, store: CredentialStore): Promise<AgentConfig> {
  const next = structuredClone(config);
  for (const [alias, provider] of Object.entries(next.providers)) {
    const apiKey = await store.get(providerCredentialAccount(alias, "apiKey"));
    const refreshToken = await store.get(providerCredentialAccount(alias, "refreshToken"));
    if (apiKey) provider.apiKey = apiKey;
    if (provider.oauth && refreshToken) provider.oauth.refreshToken = refreshToken;
  }
  const webSearchApiKey = await store.get(WEB_SEARCH_CREDENTIAL_ACCOUNT);
  if (webSearchApiKey) next.web.search.apiKey = webSearchApiKey;
  return next;
}

export async function saveStoredCredentials(config: AgentConfig, store: CredentialStore, previous?: AgentConfig): Promise<void> {
  const values: Array<{ account: string; value: string | undefined }> = [
    { account: WEB_SEARCH_CREDENTIAL_ACCOUNT, value: config.web.search.apiKey }
  ];
  for (const [alias, provider] of Object.entries(config.providers)) {
    values.push({ account: providerCredentialAccount(alias, "apiKey"), value: provider.apiKey });
    values.push({ account: providerCredentialAccount(alias, "refreshToken"), value: provider.oauth?.refreshToken });
  }
  for (const { account, value } of values) {
    if (value) await store.set(account, value);
  }
  if (previous) {
    const aliases = new Set([...Object.keys(previous.providers), ...Object.keys(config.providers)]);
    for (const alias of aliases) {
      const current = config.providers[alias];
      const old = previous.providers[alias];
      if (old?.apiKey && !current?.apiKey) await store.delete(providerCredentialAccount(alias, "apiKey"));
      if (old?.oauth?.refreshToken && !current?.oauth?.refreshToken) await store.delete(providerCredentialAccount(alias, "refreshToken"));
    }
    if (previous.web.search.apiKey && !config.web.search.apiKey) await store.delete(WEB_SEARCH_CREDENTIAL_ACCOUNT);
  }
}

function isKeychainItemMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return code === 44 || /could not be found|SecKeychainSearchCopyNext|The specified item could not be found/i.test(stderr);
}

function keychainError(action: string, account: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`无法${action} macOS Keychain 凭据 ${account}：${message}`);
}
