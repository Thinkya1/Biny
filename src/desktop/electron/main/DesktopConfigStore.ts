/**
 * 桌面端全局配置存储。
 *
 * 生产环境直接复用 CLI 的全局配置路径和 macOS Keychain；传入 DesktopSecretProtector 仅保留给
 * 旧单元测试/兼容夹具，真实桌面运行不会再创建 userData/credentials.json。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, loadConfigFile, saveConfig, saveConfigFile } from "../../../config/loader.js";
import {
  applyStoredCredentials,
  createCredentialStore,
  saveStoredCredentials,
  type CredentialStore
} from "../../../config/credentials.js";
import type { AgentConfig } from "../../../config/schema.js";
import type { AgentConfigStore } from "../../../config/store.js";

interface DesktopCredentialFile {
  version: 1;
  values: Record<string, string>;
}

export interface DesktopSecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

type DesktopCredentialBackend = DesktopSecretProtector | CredentialStore;

export class DesktopConfigStore implements AgentConfigStore {
  private writeTail = Promise.resolve();
  private readonly legacyProtector: DesktopSecretProtector | undefined;
  private readonly credentials: CredentialStore;

  constructor(private readonly root: string, backend?: DesktopCredentialBackend) {
    this.legacyProtector = backend && isSecretProtector(backend) ? backend : undefined;
    this.credentials = this.legacyProtector
      ? new EnvironmentCredentialStoreAdapter()
      : backend && isCredentialStore(backend) ? backend : createCredentialStore();
  }

  async load(workspaceRoot = this.root): Promise<AgentConfig> {
    if (this.legacyProtector) {
      const config = await loadConfigFile(this.root);
      return await this.mergeLegacyCredentials(config);
    }
    return await applyStoredCredentials(await loadConfig(workspaceRoot, { globalDir: this.root }), this.credentials);
  }

  async save(config: AgentConfig, workspaceRoot = this.root): Promise<void> {
    const run = this.writeTail.then(async () => {
      if (this.legacyProtector) {
        const existing = await this.readLegacyCredentials();
        const { settings, secrets } = separateCredentials(config);
        for (const key of Object.keys(existing)) {
          if (key.startsWith("provider:") || key === webSearchCredentialKey) delete existing[key];
        }
        await this.writeLegacyCredentials({ ...existing, ...secrets });
        await saveConfigFile(this.root, settings);
        return;
      }

      const previous = await this.load(workspaceRoot);
      await saveStoredCredentials(config, this.credentials, previous);
      await saveConfig(workspaceRoot, config, { globalDir: this.root });
    });
    this.writeTail = run.catch(() => undefined);
    await run;
  }

  configPath(): string {
    return path.join(this.root, "agent.config.json");
  }

  private async mergeLegacyCredentials(config: AgentConfig): Promise<AgentConfig> {
    const credentials = await this.readLegacyCredentials();
    const providers = Object.fromEntries(Object.entries(config.providers).map(([alias, provider]) => [alias, {
      ...provider,
      apiKey: credentials[credentialKey(alias, "apiKey")] ?? provider.apiKey,
      oauth: provider.oauth
        ? { ...provider.oauth, refreshToken: credentials[credentialKey(alias, "refreshToken")] ?? provider.oauth.refreshToken }
        : undefined
    }]));
    return {
      ...config,
      providers,
      web: { ...config.web, search: { ...config.web.search, apiKey: credentials[webSearchCredentialKey] ?? config.web.search.apiKey } }
    };
  }

  private async readLegacyCredentials(): Promise<Record<string, string>> {
    const filePath = path.join(this.root, "credentials.json");
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<DesktopCredentialFile>;
    if (parsed.version !== 1 || !isStringRecord(parsed.values)) throw new Error("Biny credentials file is malformed.");
    if (!this.legacyProtector?.isAvailable()) throw new Error("测试凭据保护器不可用，无法读取模型凭据。");
    return Object.fromEntries(Object.entries(parsed.values).map(([key, value]) => [key, this.legacyProtector!.decrypt(value)]));
  }

  /** 仅兼容旧测试夹具；生产凭据不会走这条路径。 */
  private async writeLegacyCredentials(values: Record<string, string>): Promise<void> {
    if (Object.keys(values).length && !this.legacyProtector?.isAvailable()) {
      throw new Error("测试凭据保护器不可用，无法保存模型凭据。");
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.root, "credentials.json");
    const encrypted: DesktopCredentialFile = {
      version: 1,
      values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, this.legacyProtector!.encrypt(value)]))
    };
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(encrypted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  }
}

/** 只用于让类型保持清晰：legacy protector 已经由上面的文件实现处理。 */
class EnvironmentCredentialStoreAdapter implements CredentialStore {
  readonly persistent = false;
  async get(): Promise<string | undefined> { return undefined; }
  async set(): Promise<void> { return; }
  async delete(): Promise<void> { return; }
}

function separateCredentials(config: AgentConfig): { settings: AgentConfig; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const providers = Object.fromEntries(Object.entries(config.providers).map(([alias, provider]) => {
    if (provider.apiKey) secrets[credentialKey(alias, "apiKey")] = provider.apiKey;
    if (provider.oauth?.refreshToken) secrets[credentialKey(alias, "refreshToken")] = provider.oauth.refreshToken;
    return [alias, {
      ...provider,
      apiKey: undefined,
      oauth: provider.oauth ? { ...provider.oauth, refreshToken: undefined } : undefined
    }];
  }));
  if (config.web.search.apiKey) secrets[webSearchCredentialKey] = config.web.search.apiKey;
  return {
    settings: { ...config, providers, web: { ...config.web, search: { ...config.web.search, apiKey: undefined } } },
    secrets
  };
}

function credentialKey(providerAlias: string, kind: "apiKey" | "refreshToken"): string {
  return `provider:${providerAlias}:${kind}`;
}

const webSearchCredentialKey = "web-search:apiKey";

function isSecretProtector(value: DesktopCredentialBackend): value is DesktopSecretProtector {
  return "encrypt" in value && "decrypt" in value;
}

function isCredentialStore(value: DesktopCredentialBackend): value is CredentialStore {
  return "get" in value && "set" in value && "delete" in value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
