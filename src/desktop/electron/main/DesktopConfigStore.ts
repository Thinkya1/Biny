/**
 * 桌面端配置存储。
 *
 * 把配置拆成两份落盘：设置项写进普通配置文件（可以备份、可以直接看），凭据（API key、
 * refresh token）单独写进加密文件。`load()` 时再合并回一份完整的 `AgentConfig` 给运行时用。
 *
 * 因此配置文件里永远不应出现明文 key；`separateCredentials` 是这条边界的唯一出入口。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../../../config/loader.js";
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

/** 设置与加密凭据分离存储：设置文件可安全备份查看，密钥永不写入其中。 */
export class DesktopConfigStore implements AgentConfigStore {
  private writeTail = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly protector: DesktopSecretProtector
  ) {}

  /** 读设置 + 读凭据后合并；凭据文件里有值优先，其次才是配置文件里可能残留的值。 */
  async load(): Promise<AgentConfig> {
    const config = await loadConfig(this.root);
    const credentials = await this.readCredentials();
    const providers = Object.fromEntries(Object.entries(config.providers).map(([alias, provider]) => {
      const apiKey = credentials[credentialKey(alias, "apiKey")] ?? provider.apiKey;
      const refreshToken = credentials[credentialKey(alias, "refreshToken")] ?? provider.oauth?.refreshToken;
      return [alias, {
        ...provider,
        apiKey,
        oauth: provider.oauth ? { ...provider.oauth, refreshToken } : undefined
      }];
    }));
    const webSearchApiKey = credentials[webSearchCredentialKey] ?? config.web.search.apiKey;
    return {
      ...config,
      providers,
      web: { ...config.web, search: { ...config.web.search, apiKey: webSearchApiKey } }
    };
  }

  async save(config: AgentConfig): Promise<void> {
    const { settings, secrets } = separateCredentials(config);
    const run = this.writeTail.then(async () => {
      const existing = await this.readCredentials();
      // 先清掉本次要重写的那几类键再合并，这样删掉某个 provider 后它的旧凭据不会残留。
      for (const key of Object.keys(existing)) {
        if (key.startsWith("provider:") || key === webSearchCredentialKey) delete existing[key];
      }
      await this.writeCredentials({ ...existing, ...secrets });
      await saveConfig(this.root, settings);
    });
    // 串行链只负责排队；一次失败不能让后续保存永远复读旧错误。
    this.writeTail = run.catch(() => undefined);
    return await run;
  }

  configPath(): string {
    return path.join(this.root, "agent.config.json");
  }

  private async readCredentials(): Promise<Record<string, string>> {
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
    if (!this.protector.isAvailable()) throw new Error("系统钥匙串不可用，无法读取模型凭据。");
    return Object.fromEntries(Object.entries(parsed.values).map(([key, value]) => [key, this.protector.decrypt(value)]));
  }

  /** 凭据文件按 0600 写入并用临时文件+改名替换，避免写一半被读到。 */
  private async writeCredentials(values: Record<string, string>): Promise<void> {
    if (Object.keys(values).length && !this.protector.isAvailable()) {
      throw new Error("系统钥匙串不可用，无法保存模型凭据。");
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.root, "credentials.json");
    const encrypted: DesktopCredentialFile = {
      version: 1,
      values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, this.protector.encrypt(value)]))
    };
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(encrypted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  }
}

/**
 * 把配置拆成「可明文保存的设置」和「必须加密的凭据」。
 * 拆出去的字段一律显式置为 undefined，保证它们不会被写进设置文件。
 */
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
    settings: {
      ...config,
      providers,
      web: { ...config.web, search: { ...config.web.search, apiKey: undefined } }
    },
    secrets
  };
}

function credentialKey(providerAlias: string, kind: "apiKey" | "refreshToken"): string {
  return `provider:${providerAlias}:${kind}`;
}

const webSearchCredentialKey = "web-search:apiKey";

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
