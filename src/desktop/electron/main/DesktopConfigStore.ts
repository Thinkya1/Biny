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

/**
 * Stores desktop-visible model settings separately from encrypted credentials.
 * The settings file is safe to back up or inspect; secrets never enter it.
 */
export class DesktopConfigStore implements AgentConfigStore {
  private writeTail = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly protector: DesktopSecretProtector
  ) {}

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
    return { ...config, providers };
  }

  async save(config: AgentConfig): Promise<void> {
    const { settings, secrets } = separateCredentials(config);
    this.writeTail = this.writeTail.then(async () => {
      const existing = await this.readCredentials();
      for (const key of Object.keys(existing)) {
        if (key.startsWith("provider:")) delete existing[key];
      }
      await this.writeCredentials({ ...existing, ...secrets });
      await saveConfig(this.root, settings);
    });
    return await this.writeTail;
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
  return { settings: { ...config, providers }, secrets };
}

function credentialKey(providerAlias: string, kind: "apiKey" | "refreshToken"): string {
  return `provider:${providerAlias}:${kind}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
