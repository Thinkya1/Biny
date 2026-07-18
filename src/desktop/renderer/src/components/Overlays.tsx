import { useDeferredValue, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelChoice, ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopModelConfigurationInput, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopProject, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../../../protocol.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { AppIcon } from "./AppIcon.js";
import { Icon } from "./Icon.js";
import { ProviderBrandGlyph } from "./ProviderBrandGlyph.js";

interface SearchOverlayProps {
  open: boolean;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  onClose(): void;
  onProject(projectId: string): void;
  onSession(sessionId: string): void;
}

export function SearchOverlay({ open, projects, sessions, onClose, onProject, onSession }: SearchOverlayProps): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);
  if (!presence.present) return null;
  const filteredProjects = projects.filter((project) => !deferredQuery || `${project.name} ${project.path}`.toLocaleLowerCase().includes(deferredQuery));
  const filteredSessions = sessions.filter((session) => !deferredQuery || `${session.title} ${session.firstUserMessage}`.toLocaleLowerCase().includes(deferredQuery));
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-label="搜索" className={`t-modal command-palette ${presenceClass(presence.phase)}`} role="dialog">
        <div className="search-input-wrap"><Icon name="search" /><input onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或会话" ref={inputRef} value={query} /><kbd>esc</kbd></div>
        <div className="search-results">
          {filteredProjects.length ? <h3>项目</h3> : null}
          {filteredProjects.map((project) => <button key={project.id} onClick={() => { onProject(project.id); onClose(); }} type="button"><Icon name="folder" /><span><strong>{project.name}</strong><small>{project.path}</small></span></button>)}
          {filteredSessions.length ? <h3>会话</h3> : null}
          {filteredSessions.map((session) => <button key={session.id} onClick={() => { onSession(session.id); onClose(); }} type="button"><Icon name="home" /><span><strong>{session.title}</strong><small>{session.firstUserMessage || "空会话"}</small></span></button>)}
          {!filteredProjects.length && !filteredSessions.length ? <div className="search-empty">没有匹配结果</div> : null}
        </div>
      </section>
    </ModalBackdrop>
  );
}

interface SettingsOverlayProps {
  open: boolean;
  version: string;
  workspace?: DesktopWorkspaceSnapshot;
  modelSetupRequired: boolean;
  onClose(): void;
  onSkipModelSetup(): void;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<void>;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onRemoveModelConfiguration(alias: string): Promise<void>;
  onRevealProject(): Promise<void>;
  onOpenTerminal(): Promise<void>;
  onRemoveProject(): Promise<void>;
  onCompact(): Promise<void>;
  onOpenExternal(url: string): Promise<void>;
  onStartModelLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteModelLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<void>;
  onCancelModelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}

type SettingsTab = "通用" | "外观" | "模型" | "使用统计" | "记忆" | "每日回顾" | "语音" | "开放网关" | "远程接入" | "联网搜索" | "数据" | "权限与能力" | "健康" | "关于";

const settingsNav: Array<{ badge?: string; group?: string; tab: SettingsTab; icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = [
  { group: "通用", tab: "通用", icon: "settings", label: "通用" },
  { tab: "外观", icon: "spark", label: "外观" },
  { group: "AI 与集成", tab: "模型", icon: "cpu", label: "模型" },
  { tab: "使用统计", icon: "chart", label: "使用统计" },
  { tab: "记忆", icon: "brain", label: "记忆" },
  { tab: "每日回顾", icon: "calendar", label: "每日回顾" },
  { tab: "语音", icon: "mic", label: "语音" },
  { tab: "开放网关", icon: "network", label: "开放网关" },
  { tab: "远程接入", icon: "remote", label: "远程接入" },
  { badge: "Beta", tab: "联网搜索", icon: "search", label: "联网搜索" },
  { group: "系统", tab: "数据", icon: "database", label: "数据" },
  { tab: "权限与能力", icon: "shield", label: "权限与能力" },
  { tab: "健康", icon: "activity", label: "健康" },
  { tab: "关于", icon: "help", label: "关于" }
];

const settingsSubtitles: Record<SettingsTab, string> = {
  通用: "启动与工作区基础行为。",
  模型: "模型连接、API key 与默认模型管理。",
  外观: "主题与动效偏好。",
  使用统计: "查看模型与工具的资源消耗。",
  记忆: "会话上下文与长期记忆管理。",
  每日回顾: "管理每日自动回顾的内容与节奏。",
  语音: "语音输入与输出能力设置。",
  开放网关: "管理可供外部工具接入的服务。",
  远程接入: "配置远程设备与工作区访问。",
  联网搜索: "配置联网搜索与数据来源。",
  数据: "项目、会话与本地数据管理。",
  权限与能力: "控制 Agent 可自动执行的操作范围。",
  健康: "查看桌面端运行状态与诊断信息。",
  关于: "版本与产品信息。"
};

export function SettingsOverlay({
  open,
  version,
  workspace,
  modelSetupRequired,
  onClose,
  onSkipModelSetup,
  onPermissionMode,
  onSwitchModel,
  onSaveModelConfiguration,
  onTestModelConfiguration,
  onRemoveModelConfiguration,
  onRevealProject,
  onOpenTerminal,
  onRemoveProject,
  onCompact,
  onOpenExternal,
  onStartModelLogin,
  onCompleteModelLogin,
  onCancelModelLogin
}: SettingsOverlayProps): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [tab, setTab] = useState<SettingsTab>("模型");
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(undefined), 1_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (modelSetupRequired) setTab("模型");
  }, [modelSetupRequired]);
  if (!presence.present) return null;
  const runtime = workspace?.runtime;
  const execute = async (operation: () => Promise<void>, success: string): Promise<void> => {
    setMessage(undefined);
    try {
      await operation();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const dismiss = modelSetupRequired ? () => undefined : onClose;
  return (
    <ModalBackdrop onClose={dismiss} variant="settings">
      <section aria-label="Biny 设置" className={`t-modal settings-modal is-full-page ${presenceClass(presence.phase)}`} role="dialog">
        <aside className="settings-tabs">
          {modelSetupRequired ? (
            <div className="settings-setup-notice">
              <strong>先配置模型</strong>
              <span>连接一个可用模型后才能开始任务。</span>
              <button className="settings-setup-skip" onClick={onSkipModelSetup} type="button">
                先看看，稍后配置
              </button>
            </div>
          ) : (
            <button aria-label="返回应用" className="settings-back-button" onClick={onClose} type="button">
              <Icon name="arrow-left" size={16} />
              <span>返回应用</span>
            </button>
          )}
          {settingsNav.filter((item) => !modelSetupRequired || item.tab === "模型").map((item, index, visibleSettingsNav) => (
            <div key={item.tab}>
              {item.group && (index === 0 || visibleSettingsNav[index - 1]?.group !== item.group) ? <div className="settings-nav-group">{item.group}</div> : null}
              <button aria-current={tab === item.tab ? "page" : undefined} className={tab === item.tab ? "is-selected" : ""} onClick={() => setTab(item.tab)} type="button">
                <Icon name={item.icon} size={14} />
                <span>{item.label}</span>
                {item.badge ? <em className="settings-nav-badge">{item.badge}</em> : null}
              </button>
            </div>
          ))}
        </aside>
        <main className="settings-content">
          <header>
            <div className="settings-heading">
              <h2>{modelSetupRequired ? "配置模型" : tab}</h2>
              <p>{modelSetupRequired ? "开始使用前，请先连接一个可用模型。" : settingsSubtitles[tab]}</p>
            </div>
          </header>
          {tab === "通用" ? <SettingsGeneral workspace={workspace} /> : null}
          {tab === "模型" ? <SettingsModels
            models={workspace?.models ?? []}
            runtime={runtime?.info}
            onOpenExternal={onOpenExternal}
            onStartLogin={onStartModelLogin}
            onCompleteLogin={onCompleteModelLogin}
            onCancelLogin={onCancelModelLogin}
            onChange={(alias, thinking) => execute(async () => await onSwitchModel(alias, thinking), "默认模型已更新")}
            onNotify={setMessage}
            onSave={async (configuration) => {
              setMessage(undefined);
              try {
                await onSaveModelConfiguration(configuration);
                setMessage("模型配置已保存");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
                throw error;
              }
            }}
            onTest={async (configuration) => {
              try {
                return await onTestModelConfiguration(configuration);
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return { ok: false, message: text };
              }
            }}
            onRemove={async (alias) => {
              setMessage(undefined);
              try {
                await onRemoveModelConfiguration(alias);
                setMessage("已取消启用该模型");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
                throw error;
              }
            }}
          /> : null}
          {tab === "权限与能力" ? <SettingsPermissions mode={runtime?.permissionMode ?? "ask"} onChange={(mode) => execute(async () => await onPermissionMode(mode), "权限模式已更新")} /> : null}
          {tab === "外观" ? <SettingsAppearance /> : null}
          {tab === "记忆" ? <SettingsAgent disabled={Boolean(runtime?.activeRun)} onCompact={() => execute(onCompact, "会话已压缩")} /> : null}
          {tab === "数据" ? (
            <SettingsProject
              project={workspace?.project}
              sessionCount={workspace?.sessions.length ?? 0}
              onOpenTerminal={() => execute(onOpenTerminal, "已在终端中打开")}
              onRemove={() => execute(onRemoveProject, "项目已从侧边栏移除")}
              onReveal={() => execute(onRevealProject, "已在 Finder 中显示")}
            />
          ) : null}
          {tab === "关于" ? <SettingsAbout version={version} /> : null}
          {tab === "使用统计" || tab === "每日回顾" || tab === "语音" || tab === "开放网关" || tab === "远程接入" || tab === "联网搜索" || tab === "健康" ? <SettingsComingSoon tab={tab} /> : null}
          {message ? <div className="settings-message">{message}</div> : null}
        </main>
      </section>
    </ModalBackdrop>
  );
}

export function RenameOverlay({ open, initialValue, title = "重命名会话", onClose, onSave }: { open: boolean; initialValue: string; title?: string; onClose(): void; onSave(value: string): Promise<void> }): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    window.requestAnimationFrame(() => inputRef.current?.select());
  }, [initialValue, open]);
  if (!presence.present) return null;
  return (
    <ModalBackdrop onClose={onClose}>
      <form className={`t-modal rename-modal ${presenceClass(presence.phase)}`} onSubmit={(event) => { event.preventDefault(); if (value.trim()) void onSave(value.trim()); }}>
        <h2>{title}</h2>
        <input maxLength={120} onChange={(event) => setValue(event.target.value)} ref={inputRef} value={value} />
        <div><button onClick={onClose} type="button">取消</button><button className="is-primary" disabled={!value.trim()} type="submit">保存</button></div>
      </form>
    </ModalBackdrop>
  );
}

export function Toast({ message, onClose }: { message?: string; onClose(): void }): React.JSX.Element | null {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onClose, 1_000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return message ? <div className="toast" role="status"><span>{message}</span><button onClick={onClose} type="button"><Icon name="close" size={12} /></button></div> : null;
}

function ModalBackdrop({ children, onClose, variant }: { children: React.ReactNode; onClose(): void; variant?: "settings" }): React.JSX.Element {
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const className = variant === "settings" ? "modal-backdrop is-settings" : "modal-backdrop";
  return <div className={className} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</div>;
}

function SettingsGeneral({ workspace }: { workspace?: DesktopWorkspaceSnapshot }): React.JSX.Element {
  return (
    <div className="settings-sections">
      <section><h3>启动</h3><div className="setting-row"><span><strong>重新打开上次项目</strong><small>Biny 会恢复最近项目与会话</small></span><span className="setting-value">已启用</span></div></section>
      <section><h3>当前工作区</h3><div className="setting-row"><span><strong>{workspace?.project.name ?? "没有打开项目"}</strong><small>{workspace?.project.path ?? "使用 Command+O 打开本地文件夹"}</small></span><span className="setting-value">本地</span></div></section>
    </div>
  );
}

type ProviderCategory = "推荐" | "账号" | "模型计划" | "API" | "聚合服务" | "本地";

interface CatalogModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
}

interface ProviderCatalogItem {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  badge: string;
  categories: ProviderCategory[];
  connectionMode: "api" | "login";
  loginProvider?: DesktopModelLoginProvider;
  baseUrl: string;
  requiresApiKey: boolean;
  models: CatalogModel[];
  iconTone: string;
  apiKeyUrl?: string;
}

interface ApiProviderDefinition {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  badge: string;
  categories: ProviderCategory[];
  baseUrl: string;
  requiresApiKey: boolean;
  iconTone: string;
  modelId: string;
  modelDisplayName: string;
  supportsThinking: boolean;
  apiKeyUrl?: string;
}

function apiProvider(definition: ApiProviderDefinition): ProviderCatalogItem {
  const { modelId, modelDisplayName, supportsThinking, apiKeyUrl, ...provider } = definition;
  return {
    ...provider,
    connectionMode: "api",
    models: modelId ? [{ id: modelId, displayName: modelDisplayName, supportsThinking }] : [],
    apiKeyUrl: apiKeyUrl ?? providerApiKeyUrl(definition.id)
  };
}

function providerApiKeyUrl(providerId: string): string | undefined {
  const urls: Record<string, string | undefined> = {
    deepseek: "https://platform.deepseek.com/api_keys",
    moonshot: "https://platform.moonshot.cn/console/api-keys",
    anthropic: "https://platform.claude.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    google: "https://aistudio.google.com/app/apikey",
    siliconflow: "https://cloud.siliconflow.cn/account/ak",
    "MiniMax": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    "MiniMax-cn": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    mistral: "https://console.mistral.ai/api-keys",
    togetherai: "https://api.together.ai/settings/api-keys",
    "openrouter": "https://openrouter.ai/settings/keys",
    huggingface: "https://huggingface.co/settings/tokens",
    "deepinfra": "https://deepinfra.com/dash/api_keys",
    cohere: "https://dashboard.cohere.com/api-keys",
    "fireworks-ai": "https://fireworks.ai/account/api-keys",
    nvidia: "https://build.nvidia.com/settings/api-keys",
    groq: "https://console.groq.com/keys",
    alibaba: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    qwen: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    "ollama-cloud": "https://ollama.com/settings/keys"
  };
  return urls[providerId];
}

const providerCatalog: ProviderCatalogItem[] = [
  apiProvider({ id: "kimi-coding-plan", value: "kimi", label: "Kimi Coding Plan", description: "月之暗面 · Anthropic 兼容", badge: "Coding", categories: ["推荐", "模型计划"], baseUrl: "https://api.kimi.com/coding/v1", requiresApiKey: true, iconTone: "moonshot", modelId: "kimi-k2.5", modelDisplayName: "Kimi K2.5", supportsThinking: true }),
  apiProvider({ id: "minimax-coding-plan", value: "openai-compatible", label: "MiniMax Coding Plan", description: "MiniMax Coding 套餐 · Anthropic 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.minimax.io/anthropic", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true }),
  apiProvider({ id: "deepseek", value: "deepseek", label: "DeepSeek", description: "DeepSeek 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.deepseek.com", requiresApiKey: true, iconTone: "deepseek", modelId: "deepseek-v4-flash", modelDisplayName: "DeepSeek V4 Flash", supportsThinking: true }),
  apiProvider({ id: "moonshot", value: "kimi", label: "Moonshot", description: "Moonshot 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.moonshot.cn/v1", requiresApiKey: true, iconTone: "moonshot", modelId: "kimi-k2.5", modelDisplayName: "Kimi K2.5", supportsThinking: true }),
  apiProvider({ id: "zai-coding-plan", value: "openai-compatible", label: "Z.AI Coding Plan", description: "智谱 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.z.ai/api/coding/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5", modelDisplayName: "GLM-5", supportsThinking: true }),
  apiProvider({ id: "MiniMax", value: "openai-compatible", label: "MiniMax", description: "MiniMax · Anthropic 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.minimax.io/anthropic/v1", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true }),
  apiProvider({ id: "MiniMax-cn", value: "openai-compatible", label: "MiniMax 中国站", description: "MiniMax 中国站 · Anthropic 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.minimaxi.com/anthropic/v1", requiresApiKey: true, iconTone: "minimax", modelId: "MiniMax-M3", modelDisplayName: "MiniMax M3", supportsThinking: true }),
  apiProvider({ id: "siliconflow", value: "openai-compatible", label: "SiliconFlow", description: "硅基流动多模型 API，支持精确模型 ID。", badge: "聚合", categories: ["推荐", "聚合服务"], baseUrl: "https://api.siliconflow.cn/v1", requiresApiKey: true, iconTone: "siliconflow", modelId: "deepseek-ai/DeepSeek-V3", modelDisplayName: "DeepSeek V3", supportsThinking: false }),
  apiProvider({ id: "anthropic", value: "anthropic", label: "Anthropic", description: "Anthropic 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.anthropic.com", requiresApiKey: true, iconTone: "anthropic", modelId: "claude-sonnet-4-5", modelDisplayName: "Claude Sonnet 4.5", supportsThinking: true }),
  apiProvider({ id: "openai", value: "openai", label: "OpenAI", description: "OpenAI 官方接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://api.openai.com/v1", requiresApiKey: true, iconTone: "openai", modelId: "gpt-5.2", modelDisplayName: "GPT-5.2", supportsThinking: true }),
  apiProvider({ id: "google", value: "gemini", label: "Google Gemini", description: "Google AI Studio 接入", badge: "API", categories: ["推荐", "API"], baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", requiresApiKey: true, iconTone: "gemini", modelId: "gemini-3.5-flash", modelDisplayName: "Gemini 3.5 Flash", supportsThinking: false }),
  apiProvider({ id: "xai", value: "openai-compatible", label: "xAI", description: "xAI 官方接入，Grok 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.x.ai/v1", requiresApiKey: true, iconTone: "xai", modelId: "grok-4.5", modelDisplayName: "Grok 4.5", supportsThinking: true }),
  apiProvider({ id: "zai", value: "openai-compatible", label: "Z.AI", description: "智谱官方接入，GLM 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.z.ai/api/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "xiaomi", value: "openai-compatible", label: "Xiaomi", description: "小米官方接入，MiMo 系列模型", badge: "API", categories: ["API"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5", modelDisplayName: "MiMo-V2.5", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-cn", value: "openai-compatible", label: "Xiaomi Token Plan 中国", description: "小米 MiMo Token Plan 订阅 · 中国 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-sgp", value: "openai-compatible", label: "Xiaomi Token Plan 新加坡", description: "小米 MiMo Token Plan 订阅 · 新加坡 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "xiaomi-token-plan-ams", value: "openai-compatible", label: "Xiaomi Token Plan 欧洲", description: "小米 MiMo Token Plan 订阅 · 欧洲 · 编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.xiaomimimo.com/v1", requiresApiKey: true, iconTone: "xiaomi", modelId: "mimo-v2.5-pro", modelDisplayName: "MiMo-V2.5-Pro", supportsThinking: true }),
  apiProvider({ id: "cerebras", value: "openai-compatible", label: "Cerebras", description: "高速推理托管开源模型", badge: "API", categories: ["API"], baseUrl: "https://api.cerebras.ai/v1", requiresApiKey: true, iconTone: "cerebras", modelId: "gpt-oss-120b", modelDisplayName: "GPT OSS 120B", supportsThinking: true }),
  apiProvider({ id: "mistral", value: "openai-compatible", label: "Mistral", description: "Mistral 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.mistral.ai/v1", requiresApiKey: true, iconTone: "mistral", modelId: "mistral-large-latest", modelDisplayName: "Mistral Large", supportsThinking: true }),
  apiProvider({ id: "togetherai", value: "openai-compatible", label: "Together AI", description: "托管开源模型 API", badge: "API", categories: ["API"], baseUrl: "https://api.together.ai/v1", requiresApiKey: true, iconTone: "together", modelId: "meta-llama/Llama-3.3-70B-Instruct", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "ollama", value: "ollama", label: "Ollama", description: "本机运行 · 离线可用", badge: "Local", categories: ["推荐", "本地"], baseUrl: "http://127.0.0.1:11434/v1", requiresApiKey: false, iconTone: "ollama", modelId: "llama3.2", modelDisplayName: "Llama 3.2", supportsThinking: false }),
  apiProvider({ id: "lm-studio", value: "openai-compatible", label: "LM Studio", description: "本机 LM Studio 服务 · 离线可用", badge: "Local", categories: ["本地"], baseUrl: "http://localhost:1234/v1", requiresApiKey: false, iconTone: "lm-studio", modelId: "", modelDisplayName: "", supportsThinking: false }),
  apiProvider({ id: "localai", value: "openai-compatible", label: "LocalAI", description: "本机 LocalAI 服务，可选密钥保护", badge: "Local", categories: ["本地"], baseUrl: "http://localhost:8080/v1", requiresApiKey: false, iconTone: "localai", modelId: "qwen3-8b", modelDisplayName: "Qwen3 8B", supportsThinking: false }),
  apiProvider({ id: "openai-compatible", value: "openai-compatible", label: "自定义 OpenAI 兼容接口", description: "中转站、代理服务或自部署网关。", badge: "Custom", categories: ["API", "聚合服务"], baseUrl: "", requiresApiKey: true, iconTone: "compatible", modelId: "", modelDisplayName: "", supportsThinking: false }),
  apiProvider({ id: "fireworks-ai", value: "openai-compatible", label: "Fireworks AI", description: "Serverless 开源模型托管", badge: "API", categories: ["API"], baseUrl: "https://api.fireworks.ai/inference/v1", requiresApiKey: true, iconTone: "fireworks", modelId: "accounts/fireworks/models/kimi-k2p6", modelDisplayName: "Kimi K2.6", supportsThinking: true }),
  apiProvider({ id: "nvidia", value: "openai-compatible", label: "NVIDIA", description: "NVIDIA 官方托管模型接入", badge: "API", categories: ["API"], baseUrl: "https://integrate.api.nvidia.com/v1", requiresApiKey: true, iconTone: "nvidia", modelId: "nvidia/nemotron-3-super-120b-a12b", modelDisplayName: "NVIDIA Nemotron", supportsThinking: true }),
  apiProvider({ id: "tencent-tokenhub", value: "openai-compatible", label: "Tencent TokenHub", description: "腾讯云 TokenHub 按量接入，混元等模型", badge: "API", categories: ["API"], baseUrl: "https://tokenhub.tencentmaas.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "hy3", modelDisplayName: "混元 HY 3", supportsThinking: true }),
  apiProvider({ id: "stepfun", value: "openai-compatible", label: "StepFun 中国站", description: "阶跃星辰官方接入 · 中国站", badge: "API", categories: ["API"], baseUrl: "https://api.stepfun.com/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "tencent-coding-plan", value: "openai-compatible", label: "Tencent Coding Plan", description: "腾讯云 Coding 套餐 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "tc-code-latest", modelDisplayName: "TC Code", supportsThinking: true }),
  apiProvider({ id: "stepfun-ai", value: "openai-compatible", label: "StepFun 国际站", description: "阶跃星辰官方接入 · 国际站", badge: "API", categories: ["API"], baseUrl: "https://api.stepfun.ai/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "volcengine-ark", value: "openai-compatible", label: "火山方舟", description: "火山引擎官方接入，豆包等模型", badge: "API", categories: ["API"], baseUrl: "https://ark.cn-beijing.volces.com/api/v3", requiresApiKey: true, iconTone: "volcengine", modelId: "doubao-seed-2-0-pro-260215", modelDisplayName: "Doubao Seed 2.0 Pro", supportsThinking: true }),
  apiProvider({ id: "volcengine-coding-plan", value: "openai-compatible", label: "火山方舟 Coding Plan", description: "火山引擎 Coding 订阅 · OpenAI 兼容", badge: "Coding", categories: ["模型计划"], baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", requiresApiKey: true, iconTone: "volcengine", modelId: "ark-code-latest", modelDisplayName: "Ark Code", supportsThinking: true }),
  apiProvider({ id: "tencent-token-plan", value: "openai-compatible", label: "Tencent Token Plan", description: "腾讯云 Token 套餐，个人智能体与编码工具", badge: "Token", categories: ["模型计划"], baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", requiresApiKey: true, iconTone: "tencent", modelId: "tc-code-latest", modelDisplayName: "TC Code", supportsThinking: true }),
  apiProvider({ id: "stepfun-step-plan", value: "openai-compatible", label: "StepFun Step Plan 中国站", description: "阶跃星辰订阅套餐 · 中国站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://api.stepfun.com/step_plan/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "deepinfra", value: "openai-compatible", label: "DeepInfra", description: "开源模型托管推理 · OpenAI 兼容", badge: "API", categories: ["API"], baseUrl: "https://api.deepinfra.com/v1/openai", requiresApiKey: true, iconTone: "deepinfra", modelId: "meta-llama/Llama-3.3-70B-Instruct", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "cohere", value: "openai-compatible", label: "Cohere", description: "Cohere 官方接入", badge: "API", categories: ["API"], baseUrl: "https://api.cohere.com/v2", requiresApiKey: true, iconTone: "cohere", modelId: "command-a-plus-05-2026", modelDisplayName: "Command A", supportsThinking: true }),
  apiProvider({ id: "vercel", value: "openai-compatible", label: "Vercel AI Gateway", description: "一个密钥接入多家托管模型", badge: "网关", categories: ["聚合服务"], baseUrl: "https://ai-gateway.vercel.sh/v1", requiresApiKey: true, iconTone: "vercel", modelId: "openai/gpt-5.4", modelDisplayName: "OpenAI GPT-5.4", supportsThinking: true }),
  apiProvider({ id: "stepfun-ai-step-plan", value: "openai-compatible", label: "StepFun Step Plan 国际站", description: "阶跃星辰订阅套餐 · 国际站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://api.stepfun.ai/step_plan/v1", requiresApiKey: true, iconTone: "stepfun", modelId: "step-3.7-flash", modelDisplayName: "Step 3.7 Flash", supportsThinking: true }),
  apiProvider({ id: "cloudflare-workers-ai", value: "openai-compatible", label: "Cloudflare Workers AI", description: "Cloudflare 托管模型，账户级接入", badge: "API", categories: ["API"], baseUrl: "", requiresApiKey: true, iconTone: "cloudflare", modelId: "@cf/meta/llama-3.1-8b-instruct", modelDisplayName: "Llama 3.1 8B", supportsThinking: false }),
  apiProvider({ id: "huggingface", value: "openai-compatible", label: "Hugging Face", description: "Inference Providers 路由，聚合多家托管模型", badge: "路由", categories: ["聚合服务"], baseUrl: "https://router.huggingface.co/v1", requiresApiKey: true, iconTone: "huggingface", modelId: "openai/gpt-oss-120b", modelDisplayName: "GPT OSS 120B", supportsThinking: true }),
  apiProvider({ id: "ollama-cloud", value: "openai-compatible", label: "Ollama Cloud", description: "Ollama 官方云端托管模型", badge: "API", categories: ["API"], baseUrl: "https://ollama.com/v1", requiresApiKey: true, iconTone: "ollama", modelId: "qwen3.5:397b", modelDisplayName: "Qwen 3.5 397B", supportsThinking: true }),
  apiProvider({ id: "zenmux", value: "openai-compatible", label: "ZenMux", description: "模型路由网关，一个密钥接入多家模型", badge: "网关", categories: ["聚合服务"], baseUrl: "https://zenmux.ai/api/v1", requiresApiKey: true, iconTone: "zenmux", modelId: "moonshotai/kimi-k2.5", modelDisplayName: "Kimi K2.5", supportsThinking: true }),
  apiProvider({ id: "opencode", value: "openai-compatible", label: "OpenCode Zen", description: "面向编码智能体的按量模型精选", badge: "Plan", categories: ["模型计划"], baseUrl: "https://opencode.ai/zen/v1", requiresApiKey: true, iconTone: "opencode", modelId: "claude-sonnet-4.6", modelDisplayName: "Claude Sonnet 4.6", supportsThinking: true }),
  apiProvider({ id: "opencode-go", value: "openai-compatible", label: "OpenCode Go", description: "低价订阅制的开源编码模型精选", badge: "Plan", categories: ["模型计划"], baseUrl: "https://opencode.ai/zen/go/v1", requiresApiKey: true, iconTone: "opencode", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "groq", value: "openai-compatible", label: "Groq", description: "LPU 高速推理托管开源模型", badge: "API", categories: ["API"], baseUrl: "https://api.groq.com/openai/v1", requiresApiKey: true, iconTone: "groq", modelId: "llama-3.3-70b-versatile", modelDisplayName: "Llama 3.3 70B", supportsThinking: false }),
  apiProvider({ id: "openrouter", value: "openai-compatible", label: "OpenRouter", description: "一个密钥接入各大模型厂商 · OpenAI 兼容", badge: "聚合", categories: ["聚合服务"], baseUrl: "https://openrouter.ai/api/v1", requiresApiKey: true, iconTone: "openrouter", modelId: "openai/gpt-4o", modelDisplayName: "OpenAI GPT-4o", supportsThinking: true }),
  apiProvider({ id: "alibaba", value: "openai-compatible", label: "Alibaba", description: "阿里云百炼接入，通义千问 Qwen 模型", badge: "API", categories: ["API"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen-max", modelDisplayName: "Qwen Max", supportsThinking: true }),
  apiProvider({ id: "alibaba-coding-plan-cn", value: "openai-compatible", label: "Alibaba Coding Plan 中国站", description: "阿里云百炼 Coding Plan 订阅 · 中国站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://coding.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-coding-plan", value: "openai-compatible", label: "Alibaba Coding Plan 国际站", description: "阿里云百炼 Coding Plan 订阅 · 国际站", badge: "Plan", categories: ["模型计划"], baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-token-plan-cn", value: "openai-compatible", label: "Alibaba Token Plan（团队版）", description: "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 北京", badge: "Token", categories: ["模型计划"], baseUrl: "https://coding.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "alibaba-token-plan", value: "openai-compatible", label: "Alibaba Token Plan（团队版）", description: "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 新加坡", badge: "Token", categories: ["模型计划"], baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", requiresApiKey: true, iconTone: "alibaba", modelId: "qwen3-coder-plus", modelDisplayName: "Qwen3 Coder Plus", supportsThinking: true }),
  apiProvider({ id: "qwen", value: "qwen", label: "Qwen", description: "通义千问官方接入", badge: "API", categories: [], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, iconTone: "qwen", modelId: "qwen3.5-plus", modelDisplayName: "Qwen 3.5 Plus", supportsThinking: true }),
  {
    id: "claude-code",
    value: "claude-subscription",
    label: "Claude Code",
    description: "Claude Pro / Max 订阅账号登录。",
    badge: "可用",
    categories: ["推荐", "账号"],
    connectionMode: "login",
    loginProvider: "claude-code",
    baseUrl: "https://api.anthropic.com",
    requiresApiKey: false,
    iconTone: "anthropic",
    models: []
  },
  {
    id: "openai-codex",
    value: "openai-codex",
    label: "OpenAI Codex",
    description: "ChatGPT Plus / Pro 订阅账号登录。",
    badge: "可用",
    categories: ["推荐", "账号"],
    connectionMode: "login",
    loginProvider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    requiresApiKey: false,
    iconTone: "openai",
    models: []
  },
];

const providerCatalogOrder: Record<ProviderCategory, string[]> = {
  推荐: ["claude-code", "openai-codex", "siliconflow", "anthropic", "openai", "google", "kimi-coding-plan", "deepseek", "ollama"],
  账号: ["claude-code", "openai-codex"],
  模型计划: ["kimi-coding-plan", "minimax-coding-plan", "zai-coding-plan", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "tencent-coding-plan", "volcengine-coding-plan", "tencent-token-plan", "stepfun-step-plan", "opencode", "opencode-go", "stepfun-ai-step-plan", "alibaba-coding-plan-cn", "alibaba-coding-plan", "alibaba-token-plan-cn", "alibaba-token-plan"],
  API: ["deepseek", "moonshot", "MiniMax", "MiniMax-cn", "anthropic", "openai", "google", "xai", "zai", "xiaomi", "cerebras", "mistral", "togetherai", "openai-compatible", "fireworks-ai", "nvidia", "tencent-tokenhub", "stepfun", "stepfun-ai", "volcengine-ark", "deepinfra", "cohere", "cloudflare-workers-ai", "ollama-cloud", "groq", "alibaba"],
  聚合服务: ["siliconflow", "vercel", "openai-compatible", "huggingface", "zenmux", "openrouter"],
  本地: ["ollama", "lm-studio", "localai"]
};

type ProviderOption = ProviderCatalogItem;

function providerAliasFor(option: ProviderOption, baseUrl: string): string {
  if (option.value !== "openai-compatible") return option.value;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    return hostname || "custom";
  } catch {
    return "custom";
  }
}

function modelAliasFor(providerAlias: string, model: string): string {
  const normalizedProvider = providerAlias.toLowerCase();
  const normalizedModel = model.toLowerCase();
  const alias = normalizedModel === normalizedProvider || normalizedModel.startsWith(`${normalizedProvider}-`)
    ? model
    : `${providerAlias}-${model}`;
  return alias.replace(/[^a-z0-9.-]+/gi, "-");
}

function catalogForType(type: string): ProviderCatalogItem | undefined {
  return providerCatalog.find((item) => item.value === type);
}

function catalogForConnection(connection: { provider: string; providerType: string }): ProviderCatalogItem | undefined {
  return providerCatalog.find((item) => item.value === connection.providerType && providerAliasFor(item, item.baseUrl) === connection.provider)
    ?? catalogForType(connection.providerType);
}

function connectionLabel(models: ModelChoice[]): Array<{ provider: string; providerType: string; models: ModelChoice[]; defaultModel?: ModelChoice }> {
  const groups = new Map<string, { provider: string; providerType: string; models: ModelChoice[]; defaultModel?: ModelChoice }>();
  for (const model of models) {
    const key = model.provider;
    const current = groups.get(key) ?? {
      provider: model.provider,
      providerType: model.providerType,
      models: []
    };
    current.models.push(model);
    if (!current.defaultModel) current.defaultModel = model;
    groups.set(key, current);
  }
  return [...groups.values()];
}

function mergeAvailableModels(catalogModels: CatalogModel[], configuredModels: ModelChoice[]): CatalogModel[] {
  const configuredIds = new Set(configuredModels.map((model) => model.model));
  return [
    ...configuredModels.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      supportsThinking: model.efforts.length > 0
    })),
    ...catalogModels.filter((model) => !configuredIds.has(model.id))
  ];
}

function SettingsModels({ models, runtime, onChange, onSave, onTest, onRemove, onNotify, onOpenExternal, onStartLogin, onCompleteLogin, onCancelLogin }: {
  models: ModelChoice[];
  runtime?: { modelAlias: string; thinking: ThinkingSelection };
  onChange(alias: string, thinking: ThinkingSelection): void;
  onSave(configuration: DesktopModelConfigurationInput): Promise<void>;
  onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onRemove(alias: string): Promise<void>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onStartLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCompleteLogin(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<void>;
  onCancelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}): React.JSX.Element {
  const connections = connectionLabel(models);
  const [view, setView] = useState<{ kind: "list" } | { kind: "connect"; provider: ProviderCatalogItem } | { kind: "detail"; provider: string }>({ kind: "list" });
  const [category, setCategory] = useState<ProviderCategory>("推荐");
  const [query, setQuery] = useState("");
  const [connectApiKey, setConnectApiKey] = useState("");
  const [connectBaseUrl, setConnectBaseUrl] = useState("");
  const [connectModelId, setConnectModelId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [detailApiKey, setDetailApiKey] = useState("");
  const [detailBaseUrl, setDetailBaseUrl] = useState("");
  const [detailShowKey, setDetailShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loginStage, setLoginStage] = useState<"idle" | "opening" | "waiting" | "submitted">("idle");
  const [loginRequest, setLoginRequest] = useState<DesktopModelLoginStartResult>();
  const [loginError, setLoginError] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();

  const providerOrder = providerCatalogOrder[category];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProviders = providerCatalog
    .filter((item) => {
      if (!item.categories.includes(category)) return false;
      if (!normalizedQuery) return true;
      const haystack = `${item.label} ${item.description} ${item.badge}`.toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .sort((left, right) => providerOrder.indexOf(left.id) - providerOrder.indexOf(right.id));

  const openConnect = (provider: ProviderCatalogItem): void => {
    setConnectApiKey("");
    setConnectBaseUrl(provider.baseUrl);
    setConnectModelId(provider.models[0]?.id ?? "");
    setShowKey(false);
    setTestResult(undefined);
    setLoginStage("idle");
    setLoginRequest(undefined);
    setLoginError(undefined);
    setAuthorizationCode("");
    setView({ kind: "connect", provider });
  };

  const openDetail = (providerAlias: string): void => {
    const group = connections.find((item) => item.provider === providerAlias);
    const catalog = group ? catalogForConnection(group) : undefined;
    setDetailApiKey("");
    setDetailBaseUrl(catalog?.baseUrl ?? "");
    setDetailShowKey(false);
    setAdvancedOpen(false);
    setTestResult(undefined);
    setView({ kind: "detail", provider: providerAlias });
  };

  const saveConfiguration = async (input: DesktopModelConfigurationInput): Promise<void> => {
    setSaving(true);
    try {
      await onSave(input);
    } finally {
      setSaving(false);
    }
  };

  const buildProviderConfiguration = (
    provider: ProviderCatalogItem,
    options: { apiKey?: string; baseUrl?: string; modelId?: string; requireApiKey?: boolean } = {}
  ): DesktopModelConfigurationInput | undefined => {
    const isCustom = provider.value === "openai-compatible";
    const modelId = (options.modelId ?? (isCustom ? connectModelId : provider.models[0]?.id ?? connectModelId)).trim();
    if (!modelId) return undefined;
    const apiKey = (options.apiKey ?? connectApiKey).trim();
    if ((options.requireApiKey ?? provider.requiresApiKey) && !apiKey) return undefined;
    const baseUrl = (options.baseUrl ?? (connectBaseUrl.trim() || provider.baseUrl)).trim();
    if (isCustom && !baseUrl) return undefined;
    const providerAlias = providerAliasFor(provider, baseUrl);
    const catalogModel = provider.models.find((item) => item.id === modelId);
    return {
      alias: modelAliasFor(providerAlias, modelId),
      displayName: catalogModel?.displayName ?? modelId,
      providerAlias,
      providerType: provider.value,
      model: modelId,
      baseUrl,
      apiKey: apiKey || undefined,
      apiKeyEnv: undefined,
      supportsTools: true,
      supportsThinking: catalogModel?.supportsThinking ?? false
    };
  };

  const connectProvider = async (provider: ProviderCatalogItem): Promise<void> => {
    const configuration = buildProviderConfiguration(provider, {
      apiKey: connectApiKey,
      baseUrl: connectBaseUrl.trim() || provider.baseUrl,
      modelId: provider.value === "openai-compatible" ? connectModelId : provider.models[0]?.id,
      requireApiKey: provider.requiresApiKey
    });
    if (!configuration) return;
    await saveConfiguration(configuration);
    setConnectApiKey("");
    setView({ kind: "list" });
  };

  const startLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider) return;
    setLoginStage("opening");
    setLoginError(undefined);
    try {
      const request = await onStartLogin(provider.loginProvider);
      setLoginRequest(request);
      setLoginStage("waiting");
    } catch (error) {
      setLoginStage("idle");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitLogin = async (provider: ProviderCatalogItem): Promise<void> => {
    if (!provider.loginProvider || !loginRequest) return;
    setLoginStage("submitted");
    setLoginError(undefined);
    try {
      await onCompleteLogin(
        provider.loginProvider,
        loginRequest.authRequestId,
        loginRequest.method === "paste-code" ? authorizationCode : undefined
      );
      onNotify(`连接成功 · ${provider.label}`);
      setLoginRequest(undefined);
      setView({ kind: "list" });
    } catch (error) {
      setLoginStage("waiting");
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };

  const cancelLogin = (provider: ProviderCatalogItem): void => {
    if (provider.loginProvider && loginRequest) void onCancelLogin(provider.loginProvider, loginRequest.authRequestId);
    setLoginRequest(undefined);
    setLoginError(undefined);
    setView({ kind: "list" });
  };

  const testProvider = async (configuration: DesktopModelConfigurationInput | undefined): Promise<void> => {
    if (!configuration) {
      const missing = { ok: false, message: "请先填写完整连接信息（密钥 / 模型 / 服务地址）" };
      setTestResult(missing);
      onNotify(missing.message);
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await onTest(configuration);
      setTestResult(result);
      onNotify(result.ok
        ? (result.latencyMs !== undefined ? `连接成功 · ${String(result.latencyMs)}ms` : result.message || "连接成功")
        : `连接失败：${result.message}`);
    } finally {
      setTesting(false);
    }
  };

  const detailGroup = view.kind === "detail" ? connections.find((item) => item.provider === view.provider) : undefined;
  const detailCatalog = detailGroup ? catalogForConnection(detailGroup) ?? {
    id: "custom",
    value: "openai-compatible" as const,
    label: detailGroup.provider,
    description: detailGroup.providerType,
    badge: "API",
    categories: ["API"] as ProviderCategory[],
    connectionMode: "api" as const,
    baseUrl: "",
    requiresApiKey: true,
    iconTone: "compatible",
    models: detailGroup.models.map((model) => ({ id: model.model, displayName: model.displayName, supportsThinking: model.efforts.length > 0 }))
  } : undefined;
  const detailDefaultAlias = runtime?.modelAlias;
  const detailAvailableModels = detailGroup && detailCatalog
    ? mergeAvailableModels(detailCatalog.models, detailGroup.models)
    : [];

  const saveKey = async (): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    const active = detailGroup.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup.defaultModel ?? detailGroup.models[0];
    if (!active || !detailApiKey.trim()) return;
    await saveConfiguration({
      alias: active.alias,
      displayName: active.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      model: active.model,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: detailApiKey.trim(),
      apiKeyEnv: undefined,
      supportsTools: active.supportsTools !== false,
      supportsThinking: active.efforts.length > 0
    });
    setDetailApiKey("");
  };

  const saveBaseUrl = async (): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    const active = detailGroup.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup.defaultModel ?? detailGroup.models[0];
    if (!active) return;
    await saveConfiguration({
      alias: active.alias,
      displayName: active.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      model: active.model,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: undefined,
      apiKeyEnv: undefined,
      supportsTools: active.supportsTools !== false,
      supportsThinking: active.efforts.length > 0
    });
  };

  const enableModel = async (catalogModel: CatalogModel): Promise<void> => {
    if (!detailGroup || !detailCatalog) return;
    await saveConfiguration({
      alias: modelAliasFor(detailGroup.provider, catalogModel.id),
      displayName: catalogModel.displayName,
      providerAlias: detailGroup.provider,
      providerType: detailCatalog.value,
      model: catalogModel.id,
      baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
      apiKey: undefined,
      apiKeyEnv: undefined,
      supportsTools: true,
      supportsThinking: catalogModel.supportsThinking
    });
  };

  const disableModel = async (alias: string): Promise<void> => {
    setSaving(true);
    try {
      await onRemove(alias);
    } finally {
      setSaving(false);
    }
  };

  const detailActive = detailGroup?.models.find((model) => model.alias === detailDefaultAlias) ?? detailGroup?.defaultModel ?? detailGroup?.models[0];
  const detailConfiguration: DesktopModelConfigurationInput | undefined = detailActive && detailGroup && detailCatalog ? {
    alias: detailActive.alias,
    displayName: detailActive.displayName,
    providerAlias: detailGroup.provider,
    providerType: detailCatalog.value,
    model: detailActive.model,
    baseUrl: detailBaseUrl.trim() || detailCatalog.baseUrl || undefined,
    apiKey: detailApiKey.trim() || undefined,
    apiKeyEnv: undefined,
    supportsTools: detailActive.supportsTools !== false,
    supportsThinking: detailActive.efforts.length > 0
  } : undefined;

  const deleteConnection = async (): Promise<void> => {
    if (!detailGroup) return;
    if (models.length <= detailGroup.models.length) {
      onNotify("至少需要保留一个模型连接");
      return;
    }
    setSaving(true);
    try {
      for (const model of detailGroup.models) await onRemove(model.alias);
      setView({ kind: "list" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="settings-sections model-settings">
      <section className="connection-section">
        <div className="section-heading-row">
          <div>
            <h3>已连接</h3>
            <p>管理默认模型、凭据与需要处理的连接状态。</p>
          </div>
          {connections.length ? <span className="section-count">{connections.length} 个连接</span> : null}
        </div>
        {connections.length ? (
          <div className="connection-list">
            {connections.map((connection) => {
              const catalog = catalogForConnection(connection);
              const isDefault = connection.models.some((model) => model.alias === runtime?.modelAlias);
              return (
                <button className={`connection-card${isDefault ? " is-default" : ""}`} key={connection.provider} onClick={() => openDetail(connection.provider)} type="button">
                  <span className={`provider-mark is-${catalog?.iconTone ?? "compatible"}`}><ProviderGlyph type={catalog?.iconTone ?? "compatible"} /></span>
                  <span className="connection-card-copy">
                    <strong>
                      {catalog?.label ?? connection.provider}
                      {isDefault ? <span className="default-pill">默认</span> : null}
                    </strong>
                    <small>{catalog?.label ?? connection.providerType}</small>
                  </span>
                  <Icon name="chevron" className="connection-chevron" size={14} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="connection-empty">
            <strong>还没有模型连接</strong>
            <span>从下方选择一种连接方式开始。</span>
          </div>
        )}
      </section>

      <section className="connection-section">
        <div className="section-heading-row">
          <div>
            <h3>添加新连接</h3>
            <p>选择账号登录、模型计划、API、聚合服务或本地运行时。</p>
          </div>
        </div>
        <div className="provider-category-tabs">
          {(["推荐", "账号", "模型计划", "API", "聚合服务", "本地"] as ProviderCategory[]).map((name) => (
            <button className={category === name ? "is-selected" : ""} key={name} onClick={() => setCategory(name)} type="button">{name}</button>
          ))}
        </div>
        <label className="provider-search">
          <Icon name="search" size={14} />
          <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务商" value={query} />
        </label>
        <div className="provider-catalog-list">
          {filteredProviders.map((provider) => (
            <button className="provider-catalog-row" key={provider.id} onClick={() => openConnect(provider)} type="button">
              <span className={`provider-mark is-${provider.iconTone}`}><ProviderGlyph type={provider.iconTone} /></span>
              <span className="provider-catalog-copy">
                <strong>{provider.label}</strong>
                <small>{provider.description}</small>
              </span>
              <span className="provider-badge">{provider.badge}</span>
              <Icon name="chevron" className="connection-chevron" size={14} />
            </button>
          ))}
          {!filteredProviders.length ? <div className="settings-empty">没有匹配的服务商</div> : null}
        </div>
      </section>
      </div>
      {view.kind === "connect" ? createPortal(
        <ModelDialogBackdrop onClose={() => {
          if (view.provider.connectionMode === "login") cancelLogin(view.provider);
          else setView({ kind: "list" });
        }}>
          {view.provider.connectionMode === "login" ? (
            <LoginProviderDialog
              provider={view.provider}
              stage={loginStage}
              loginRequest={loginRequest}
              error={loginError}
              authorizationCode={authorizationCode}
              onAuthorizationCode={setAuthorizationCode}
              onStart={() => void startLogin(view.provider)}
              onSubmit={() => void submitLogin(view.provider)}
              onCancel={() => cancelLogin(view.provider)}
            />
          ) : (
            <ConnectProviderDialog
              provider={view.provider}
              apiKey={connectApiKey}
              baseUrl={connectBaseUrl}
              modelId={connectModelId}
              showKey={showKey}
              saving={saving}
              testing={testing}
              testResult={testResult}
              isCustom={view.provider.value === "openai-compatible"}
              onApiKey={(value) => { setConnectApiKey(value); setTestResult(undefined); }}
              onBaseUrl={(value) => { setConnectBaseUrl(value); setTestResult(undefined); }}
              onModelId={(value) => { setConnectModelId(value); setTestResult(undefined); }}
              onToggleKey={() => setShowKey((value) => !value)}
              onCancel={() => setView({ kind: "list" })}
              onTest={() => void testProvider(buildProviderConfiguration(view.provider, {
                apiKey: connectApiKey,
                baseUrl: connectBaseUrl.trim() || view.provider.baseUrl,
                modelId: view.provider.value === "openai-compatible" ? connectModelId : view.provider.models[0]?.id,
                requireApiKey: view.provider.requiresApiKey
              }))}
              onSubmit={() => void connectProvider(view.provider)}
              onOpenExternal={onOpenExternal}
            />
          )}
        </ModelDialogBackdrop>,
        document.body
      ) : null}
      {detailGroup && detailCatalog ? createPortal(
        <ModelDialogBackdrop onClose={() => setView({ kind: "list" })}>
          <ConnectionDetailDialog
            group={detailGroup}
            catalog={detailCatalog}
            availableModels={detailAvailableModels}
            defaultAlias={detailDefaultAlias}
            apiKey={detailApiKey}
            baseUrl={detailBaseUrl}
            showKey={detailShowKey}
            advancedOpen={advancedOpen}
            saving={saving}
            testing={testing}
            testResult={testResult}
            configuration={detailConfiguration}
            onApiKey={(value) => { setDetailApiKey(value); setTestResult(undefined); }}
            onBaseUrl={(value) => { setDetailBaseUrl(value); setTestResult(undefined); }}
            onToggleKey={() => setDetailShowKey((value) => !value)}
            onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
            onClose={() => setView({ kind: "list" })}
            onTest={() => void testProvider(detailConfiguration)}
            onSaveKey={() => void saveKey()}
            onSaveBaseUrl={() => void saveBaseUrl()}
            onEnableModel={(model) => void enableModel(model)}
            onDisableModel={(alias) => void disableModel(alias)}
            onDeleteConnection={() => void deleteConnection()}
            canDeleteConnection={models.length > detailGroup.models.length}
            onNotify={onNotify}
            onOpenExternal={onOpenExternal}
            onChange={onChange}
          />
        </ModelDialogBackdrop>,
        document.body
      ) : null}
    </>
  );
}

type ConnectionGroup = ReturnType<typeof connectionLabel>[number];

function ModelDialogBackdrop({ children, onClose }: { children: React.ReactNode; onClose(): void }): React.JSX.Element {
  return <div className="model-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</div>;
}

function LoginProviderDialog({
  provider,
  stage,
  loginRequest,
  error,
  authorizationCode,
  onAuthorizationCode,
  onStart,
  onSubmit,
  onCancel
}: {
  provider: ProviderCatalogItem;
  stage: "idle" | "opening" | "waiting" | "submitted";
  loginRequest?: DesktopModelLoginStartResult;
  error?: string;
  authorizationCode: string;
  onAuthorizationCode(value: string): void;
  onStart(): void;
  onSubmit(): void;
  onCancel(): void;
}): React.JSX.Element {
  const waiting = stage !== "idle";
  const usesPasteCode = loginRequest?.method === "paste-code";
  const isCodex = provider.id === "openai-codex";
  const loginSubtitle = provider.id === "claude-code"
    ? "登录 Claude Pro / Max 后，验证该账号实际可用模型。"
    : "登录 ChatGPT Plus / Pro 后，验证该账号实际可用 Codex 模型。";
  const subscriptionTitle = provider.id === "claude-code" ? "Claude 订阅 (Pro / Max)" : `${provider.label} 订阅`;
  const authorizationHost = provider.id === "claude-code" ? "Claude.ai" : "ChatGPT";
  return (
    <section className={`connect-dialog login-dialog${waiting ? " is-waiting" : ""}`} role="dialog" aria-label={`连接 ${provider.label}`}>
      <header>
        <div className="connection-detail-title">
          <span className={`provider-mark is-${provider.iconTone}`}><ProviderGlyph type={provider.iconTone} /></span>
          <div>
            <strong>连接 {provider.label}</strong>
            <small>{loginSubtitle}</small>
          </div>
        </div>
        <button aria-label="关闭连接对话框" className="icon-button" onClick={onCancel} type="button"><Icon name="close" /></button>
      </header>
      <div className="login-section-label">订阅</div>
      <div className="login-subscription-card">
        <div className="login-subscription-heading">
          <div>
            <strong>{subscriptionTitle}</strong>
            <small>通过 {provider.label} 官方 OAuth 登录使用订阅配额。</small>
          </div>
          <span className={`login-status${waiting ? " is-waiting" : ""}`}>{stage === "submitted" ? "正在验证..." : stage === "opening" ? "正在打开..." : waiting ? "等待登录..." : "未登录"}</span>
        </div>
        {!waiting ? <p>使用订阅配额前需要先通过官方 OAuth 登录。</p> : <p>{usesPasteCode ? "请在浏览器完成登录后粘贴授权码。" : isCodex ? "请在弹出的浏览器窗口完成登录，浏览器会自动返回此应用。" : "正在准备登录。"}</p>}
        {!waiting ? (
          <button className="login-primary-button" onClick={onStart} type="button">登录订阅</button>
        ) : (
          <button className="login-primary-button" disabled={stage !== "waiting"} onClick={usesPasteCode ? undefined : onSubmit} type="button">{usesPasteCode ? "登录中..." : "完成登录"}</button>
        )}
        {usesPasteCode ? (
          <div className="login-code-panel">
            <p>在 {authorizationHost} 完成登录后，会跳转到控制台显示一段授权码（含 <code>#</code> 分隔符），把它粘贴到下面：</p>
            <small>提示：你的 state 以 <code>{loginRequest?.stateHint}</code> 开头。</small>
            <textarea
              autoFocus
              onChange={(event) => onAuthorizationCode(event.target.value)}
              placeholder="粘贴授权码（格式：xxx#yyy）"
              value={authorizationCode}
            />
            <div className="login-code-actions">
              <button className="login-primary-button" disabled={!authorizationCode.trim() || stage === "submitted"} onClick={onSubmit} type="button">提交授权码</button>
              <button onClick={onCancel} type="button">取消</button>
            </div>
          </div>
        ) : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

function ConnectionDetailDialog({
  group,
  catalog,
  availableModels,
  defaultAlias,
  apiKey,
  baseUrl,
  showKey,
  advancedOpen,
  saving,
  testing,
  testResult,
  configuration,
  onApiKey,
  onBaseUrl,
  onToggleKey,
  onToggleAdvanced,
  onClose,
  onTest,
  onSaveKey,
  onSaveBaseUrl,
  onEnableModel,
  onDisableModel,
  onDeleteConnection,
  canDeleteConnection,
  onNotify,
  onOpenExternal,
  onChange
}: {
  group: ConnectionGroup;
  catalog: ProviderCatalogItem;
  availableModels: CatalogModel[];
  defaultAlias?: string;
  apiKey: string;
  baseUrl: string;
  showKey: boolean;
  advancedOpen: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  configuration?: DesktopModelConfigurationInput;
  onApiKey(value: string): void;
  onBaseUrl(value: string): void;
  onToggleKey(): void;
  onToggleAdvanced(): void;
  onClose(): void;
  onTest(): void;
  onSaveKey(): void;
  onSaveBaseUrl(): void;
  onEnableModel(model: CatalogModel): void;
  onDisableModel(alias: string): void;
  onDeleteConnection(): void;
  canDeleteConnection: boolean;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onChange(alias: string, thinking: ThinkingSelection): void;
}): React.JSX.Element {
  const [modelQuery, setModelQuery] = useState("");
  const filteredModels = availableModels.filter((model) => !modelQuery.trim() || `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()));
  const isDefaultConnection = group.models.some((model) => model.alias === defaultAlias);
  const apiKeyUrl = catalog.apiKeyUrl;
  return (
    <section className={`connect-dialog connection-detail-dialog${advancedOpen ? " is-advanced" : ""}`} role="dialog" aria-label={`${catalog.label} 连接设置`}>
      <header>
        <div className="connection-detail-title">
          <span className={`provider-mark is-${catalog.iconTone}`}><ProviderGlyph type={catalog.iconTone} /></span>
          <div>
            <strong>{catalog.label}</strong>
            <small>{isDefaultConnection ? "默认连接" : "已连接"}</small>
          </div>
        </div>
        <button aria-label="关闭连接设置" className="icon-button" onClick={onClose} type="button"><Icon name="close" /></button>
      </header>

      <div className="connection-field">
        <div className="connection-field-label">
          <span>模型密钥</span>
          <small>已设置，粘贴新值可替换</small>
        </div>
        <div className="secret-input-row">
          <input
            autoComplete="off"
            onChange={(event) => onApiKey(event.target.value)}
            placeholder="••••••••"
            type={showKey ? "text" : "password"}
            value={apiKey}
          />
          <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" onClick={onToggleKey} type="button">
            <Icon name={showKey ? "eye-off" : "eye"} size={14} />
          </button>
        </div>
      </div>

      <div className="connection-inline-row">
        {apiKeyUrl ? <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取模型密钥</a> : <span className="settings-link is-disabled">请向服务商获取密钥</span>}
        <button className="ghost-button" disabled={saving || !apiKey.trim()} onClick={onSaveKey} type="button">更新密钥</button>
      </div>
      {testResult && !advancedOpen ? <ConnectionTestResult result={testResult} /> : null}

      <button className="advanced-toggle" onClick={onToggleAdvanced} type="button">
        <Icon name="chevron" size={12} style={{ transform: advancedOpen ? "rotate(0deg)" : "rotate(-90deg)" }} />
        高级设置
      </button>

      {advancedOpen ? (
        <div className="connection-advanced">
          <div className="connection-field">
            <div className="connection-field-label">
              <span>启用模型 {group.models.length}</span>
              <small>勾选的模型会出现在模型选择器中。</small>
            </div>
            <label className="model-search-input">
              <Icon name="search" size={13} />
              <input onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" value={modelQuery} />
            </label>
            <div className="enabled-model-list">
              {filteredModels.map((catalogModel) => {
                const configured = group.models.find((model) => model.model === catalogModel.id);
                const isDefault = configured?.alias === defaultAlias;
                const enabled = Boolean(configured);
                return (
                  <div className={`enabled-model-row${enabled ? " is-enabled" : ""}${isDefault ? " is-default" : ""}`} key={catalogModel.id}>
                    <button
                      aria-label={enabled ? `取消启用 ${catalogModel.displayName}` : `启用 ${catalogModel.displayName}`}
                      className="enabled-model-toggle"
                      disabled={saving}
                      onClick={() => {
                        if (configured) onDisableModel(configured.alias);
                        else onEnableModel(catalogModel);
                      }}
                      type="button"
                    >
                      <span className={`check-dot${enabled ? " is-on" : ""}`}><Icon name="check" size={11} /></span>
                      <span className="enabled-model-name">{catalogModel.displayName}</span>
                    </button>
                    {enabled && configured ? (
                      isDefault
                        ? <span className="default-pill">默认</span>
                        : <button className="set-default-button" disabled={saving} onClick={() => onChange(configured.alias, configured.defaultThinking)} type="button">设为默认</button>
                    ) : null}
                  </div>
                );
              })}
              {!filteredModels.length ? <div className="model-list-empty">没有匹配的模型</div> : null}
            </div>
          </div>

          <div className="connection-field">
            <div className="connection-field-label"><span>服务地址</span></div>
            <div className="secret-input-row">
              <input onChange={(event) => onBaseUrl(event.target.value)} placeholder="https://api.example.com" value={baseUrl} />
              <button className="ghost-button" disabled={saving} onClick={onSaveBaseUrl} type="button">保存服务地址</button>
            </div>
          </div>
          {testResult ? <ConnectionTestResult result={testResult} /> : null}
          <div className="connection-detail-footer">
            <div>
              <button className="ghost-button" disabled={saving || testing || !configuration} onClick={onTest} type="button">{testing ? "测试中…" : "测试连接"}</button>
              <button className="text-button" disabled={saving} onClick={() => onNotify("模型目录已更新")} type="button">更新模型目录</button>
            </div>
            <button className="danger-text-button" disabled={saving || !canDeleteConnection} onClick={onDeleteConnection} type="button">删除连接</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ConnectProviderDialog({
  provider,
  apiKey,
  baseUrl,
  modelId,
  showKey,
  saving,
  testing,
  testResult,
  isCustom,
  onApiKey,
  onBaseUrl,
  onModelId,
  onToggleKey,
  onCancel,
  onTest,
  onSubmit,
  onOpenExternal
}: {
  provider: ProviderCatalogItem;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  showKey: boolean;
  saving: boolean;
  testing: boolean;
  testResult?: DesktopModelConnectionTestResult;
  isCustom: boolean;
  onApiKey(value: string): void;
  onBaseUrl(value: string): void;
  onModelId(value: string): void;
  onToggleKey(): void;
  onCancel(): void;
  onTest(): void;
  onSubmit(): void;
  onOpenExternal(url: string): Promise<void>;
}): React.JSX.Element {
  const canSubmit = !(provider.requiresApiKey && !apiKey.trim()) && !(isCustom && (!modelId.trim() || !baseUrl.trim()));
  const apiKeyUrl = provider.apiKeyUrl;
  return (
    <div className="connect-dialog" role="dialog" aria-label={`连接 ${provider.label}`}>
        <header>
          <div className="connection-detail-title">
            <span className={`provider-mark is-${provider.iconTone}`}><ProviderGlyph type={provider.iconTone} /></span>
            <div>
              <strong>连接 {provider.label}</strong>
              <small>完成必要配置后，连接会出现在模型页上方。</small>
            </div>
          </div>
          <button aria-label="关闭连接对话框" className="icon-button" onClick={onCancel} type="button"><Icon name="close" /></button>
        </header>
        <div className="connection-field">
          <div className="connection-field-label"><span>API Key</span></div>
          <div className="secret-input-row">
            <input
              autoComplete="off"
              autoFocus
              onChange={(event) => onApiKey(event.target.value)}
              placeholder={provider.requiresApiKey ? "输入或粘贴 API Key" : "本地服务通常无需填写"}
              type={showKey ? "text" : "password"}
              value={apiKey}
            />
            <button aria-label={showKey ? "隐藏密钥" : "显示密钥"} className="icon-button" onClick={onToggleKey} type="button">
              <Icon name={showKey ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
          {apiKeyUrl ? <a className="settings-link" href={apiKeyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(apiKeyUrl); }} rel="noreferrer">获取模型密钥</a> : null}
        </div>
        {isCustom ? (
          <>
            <div className="connection-field">
              <div className="connection-field-label"><span>模型 ID</span></div>
              <input onChange={(event) => onModelId(event.target.value)} placeholder="例如 gpt-5.2" value={modelId} />
            </div>
            <div className="connection-field">
              <div className="connection-field-label"><span>服务地址</span></div>
              <input onChange={(event) => onBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" value={baseUrl} />
            </div>
          </>
        ) : null}
        {testResult ? <ConnectionTestResult result={testResult} /> : null}
        <div className="connect-dialog-actions">
          <button onClick={onCancel} type="button">取消</button>
          <button disabled={saving || testing || !canSubmit} onClick={onTest} type="button">{testing ? "测试中…" : "测试连接"}</button>
          <button
            className="is-primary"
            disabled={saving || testing || !canSubmit}
            onClick={onSubmit}
            type="button"
          >
            连接并使用
          </button>
        </div>
    </div>
  );
}

function ConnectionTestResult({ result }: { result: DesktopModelConnectionTestResult }): React.JSX.Element {
  const text = result.ok
    ? (result.latencyMs !== undefined ? `连接成功 · ${String(result.latencyMs)}ms` : result.message || "连接成功")
    : result.message || "连接失败";
  return (
    <div className={`connection-test-result${result.ok ? " is-ok" : " is-error"}`} role="status">
      <Icon name={result.ok ? "check" : "warning"} size={13} />
      <span>{text}</span>
    </div>
  );
}

function ProviderGlyph({ type }: { type: string }): React.JSX.Element {
  const common = { "aria-hidden": true, className: "provider-logo", viewBox: "0 0 24 24" } as const;
  if (type === "deepseek") return <svg {...common}><path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" fill="currentColor" /></svg>;
  if (type === "openai" || type === "compatible") return <svg {...common}><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zM9.403 10.498l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" fill="currentColor" /></svg>;
  if (type === "qwen") return <svg {...common}><path d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" fill="currentColor" /></svg>;
  return <ProviderBrandGlyph type={type} />;
}

function SettingsPermissions({ mode, onChange }: { mode: PermissionMode; onChange(mode: PermissionMode): void }): React.JSX.Element {
  const options: Array<{ value: PermissionMode; title: string; detail: string }> = [
    { value: "ask", title: "每次询问", detail: "敏感写入和命令由你逐次决定" },
    { value: "auto", title: "自动允许安全修改", detail: "低风险操作自动放行" },
    { value: "read-only", title: "只读", detail: "拒绝非读取操作" },
    { value: "full-access", title: "完全访问", detail: "自动允许大多数工具；关键操作仍受项目策略保护" }
  ];
  return <div className="settings-sections"><section><h3>当前项目权限</h3>{options.map((option) => <button className="permission-setting-row" key={option.value} onClick={() => onChange(option.value)} type="button"><span className={`radio${mode === option.value ? " is-selected" : ""}`} /><span><strong>{option.title}</strong><small>{option.detail}</small></span></button>)}</section></div>;
}

function SettingsAppearance(): React.JSX.Element {
  return <div className="settings-sections"><section><h3>主题</h3><div className="setting-row"><span><strong>跟随 macOS</strong><small>自动适配系统浅色与深色模式</small></span><span className="setting-value">系统</span></div><div className="setting-row"><span><strong>减少动画</strong><small>自动遵循系统“减少动态效果”设置</small></span><span className="setting-value">系统</span></div></section></div>;
}

function SettingsComingSoon({ tab }: { tab: "使用统计" | "每日回顾" | "语音" | "开放网关" | "远程接入" | "联网搜索" | "健康" }): React.JSX.Element {
  return (
    <div className="settings-sections settings-coming-soon">
      <section>
        <h3>{tab}</h3>
        <p>该设置入口已纳入桌面端导航，详细配置将在后续版本接入。</p>
      </section>
    </div>
  );
}

function SettingsAgent({ disabled, onCompact }: { disabled: boolean; onCompact(): void }): React.JSX.Element {
  return (
    <div className="settings-sections">
      <section>
        <h3>会话上下文</h3>
        <div className="setting-row">
          <span><strong>压缩当前会话</strong><small>调用现有 ContextRuntime 的真实压缩流程</small></span>
          <button className="ghost-button" disabled={disabled} onClick={onCompact} type="button">立即压缩</button>
        </div>
      </section>
    </div>
  );
}

function SettingsProject({ project, sessionCount, onReveal, onOpenTerminal, onRemove }: { project?: DesktopProject; sessionCount: number; onReveal(): void; onOpenTerminal(): void; onRemove(): void }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{project?.name ?? "没有项目"}</h3><div className="project-settings-path">{project?.path}</div><div className="project-settings-meta">{String(sessionCount)} 个会话{project?.branch ? ` · ${project.branch}` : ""}{project?.dirty ? " · 有未提交修改" : ""}</div><div className="settings-button-row"><button disabled={!project} onClick={onReveal} type="button">在 Finder 中显示</button><button disabled={!project} onClick={onOpenTerminal} type="button">在终端中打开</button><button className="is-danger" disabled={!project} onClick={onRemove} type="button">从侧边栏移除</button></div></section></div>;
}

function SettingsAbout({ version }: { version: string }): React.JSX.Element {
  return <div className="about-settings"><AppIcon className="about-mark" size={66} /><h3>Biny</h3><p>版本 {version}</p><p>基于现有 Biny Agent 核心的 macOS 桌面交互层。</p></div>;
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
