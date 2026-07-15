import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { ModelChoice, ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../permission/PermissionManager.js";
import type { DesktopModelConfigurationInput, DesktopProject, DesktopSessionSummary, DesktopWorkspaceSnapshot } from "../../../protocol.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { AppIcon } from "./AppIcon.js";
import { Icon } from "./Icon.js";

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
  onClose(): void;
  onPermissionMode(mode: PermissionMode): Promise<void>;
  onSwitchModel(alias: string, thinking: ThinkingSelection): Promise<void>;
  onSaveModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<void>;
  onRevealProject(): Promise<void>;
  onOpenTerminal(): Promise<void>;
  onRemoveProject(): Promise<void>;
  onCompact(): Promise<void>;
}

const settingsTabs = ["通用", "模型", "权限", "外观", "Agent", "项目和会话", "关于"] as const;
type SettingsTab = typeof settingsTabs[number];

export function SettingsOverlay({
  open,
  version,
  workspace,
  onClose,
  onPermissionMode,
  onSwitchModel,
  onSaveModelConfiguration,
  onRevealProject,
  onOpenTerminal,
  onRemoveProject,
  onCompact
}: SettingsOverlayProps): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [tab, setTab] = useState<SettingsTab>("通用");
  const [message, setMessage] = useState<string>();
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
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-label="Biny 设置" className={`t-modal settings-modal ${presenceClass(presence.phase)}`} role="dialog">
        <aside className="settings-tabs">
          <div className="settings-title"><Icon name="settings" /><span>设置</span></div>
          {settingsTabs.map((name) => <button className={tab === name ? "is-selected" : ""} key={name} onClick={() => setTab(name)} type="button">{name}</button>)}
        </aside>
        <main className="settings-content">
          <header><h2>{tab}</h2><button aria-label="关闭设置" className="icon-button" onClick={onClose} type="button"><Icon name="close" /></button></header>
          {tab === "通用" ? <SettingsGeneral workspace={workspace} /> : null}
          {tab === "模型" ? <SettingsModels models={workspace?.models ?? []} runtime={runtime?.info} onChange={(alias, thinking) => execute(async () => await onSwitchModel(alias, thinking), "模型已更新")} onSave={async (configuration) => {
            setMessage(undefined);
            try {
              await onSaveModelConfiguration(configuration);
              setMessage("模型配置已保存");
            } catch (error) {
              setMessage(error instanceof Error ? error.message : String(error));
              throw error;
            }
          }} /> : null}
          {tab === "权限" ? <SettingsPermissions mode={runtime?.permissionMode ?? "ask"} onChange={(mode) => execute(async () => await onPermissionMode(mode), "权限模式已更新")} /> : null}
          {tab === "外观" ? <SettingsAppearance /> : null}
          {tab === "Agent" ? <SettingsAgent disabled={Boolean(runtime?.activeRun)} onCompact={() => execute(onCompact, "会话已压缩")} /> : null}
          {tab === "项目和会话" ? (
            <SettingsProject
              project={workspace?.project}
              sessionCount={workspace?.sessions.length ?? 0}
              onOpenTerminal={() => execute(onOpenTerminal, "已在终端中打开")}
              onRemove={() => execute(onRemoveProject, "项目已从侧边栏移除")}
              onReveal={() => execute(onRevealProject, "已在 Finder 中显示")}
            />
          ) : null}
          {tab === "关于" ? <SettingsAbout version={version} /> : null}
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
    const timer = setTimeout(onClose, 3_000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return message ? <div className="toast" role="status"><span>{message}</span><button onClick={onClose} type="button"><Icon name="close" size={12} /></button></div> : null;
}

function ModalBackdrop({ children, onClose }: { children: React.ReactNode; onClose(): void }): React.JSX.Element {
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</div>;
}

function SettingsGeneral({ workspace }: { workspace?: DesktopWorkspaceSnapshot }): React.JSX.Element {
  return (
    <div className="settings-sections">
      <section><h3>启动</h3><div className="setting-row"><span><strong>重新打开上次项目</strong><small>Biny 会恢复最近项目与会话</small></span><span className="setting-value">已启用</span></div></section>
      <section><h3>当前工作区</h3><div className="setting-row"><span><strong>{workspace?.project.name ?? "没有打开项目"}</strong><small>{workspace?.project.path ?? "使用 Command+O 打开本地文件夹"}</small></span><span className="setting-value">本地</span></div></section>
    </div>
  );
}

const providerOptions = [
  { value: "deepseek", label: "DeepSeek", description: "DeepSeek V4 Flash，适合日常 Agent 任务", model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", baseUrl: "https://api.deepseek.com", requiresApiKey: true, supportsThinking: true },
  { value: "openai", label: "OpenAI", description: "OpenAI 的 GPT 系列模型", model: "gpt-5.2", displayName: "GPT-5.2", baseUrl: "https://api.openai.com/v1", requiresApiKey: true, supportsThinking: true },
  { value: "anthropic", label: "Anthropic", description: "Claude 系列模型", model: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", baseUrl: "https://api.anthropic.com", requiresApiKey: true, supportsThinking: true },
  { value: "gemini", label: "Google Gemini", description: "Gemini 的快速通用模型", model: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", requiresApiKey: true, supportsThinking: false },
  { value: "kimi", label: "Kimi", description: "Kimi K2.5", model: "kimi-k2.5", displayName: "Kimi K2.5", baseUrl: "https://api.moonshot.ai/v1", requiresApiKey: true, supportsThinking: true },
  { value: "qwen", label: "Qwen", description: "通义千问的通用模型", model: "qwen3.5-plus", displayName: "Qwen 3.5 Plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, supportsThinking: true },
  { value: "ollama", label: "Ollama（本地）", description: "使用已安装的本地模型", model: "qwen3.5:latest", displayName: "Qwen 3.5", baseUrl: "http://127.0.0.1:11434/v1", requiresApiKey: false, supportsThinking: false },
  { value: "openai-compatible", label: "其他 OpenAI 兼容服务", description: "适用于自建网关、代理或未预置的服务商", model: "", displayName: "", baseUrl: "", requiresApiKey: true, supportsThinking: false }
] as const;

type ProviderOption = (typeof providerOptions)[number];

function providerAliasFor(option: ProviderOption, baseUrl: string): string {
  if (option.value !== "openai-compatible") return option.value;
  const hostname = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return hostname || "custom";
}

function SettingsModels({ models, runtime, onChange, onSave }: { models: ModelChoice[]; runtime?: { modelAlias: string; thinking: ThinkingSelection }; onChange(alias: string, thinking: ThinkingSelection): void; onSave(configuration: DesktopModelConfigurationInput): Promise<void> }): React.JSX.Element {
  const [providerType, setProviderType] = useState<DesktopModelConfigurationInput["providerType"]>("deepseek");
  const [baseUrl, setBaseUrl] = useState<string>(providerOptions[0].baseUrl);
  const [model, setModel] = useState<string>(providerOptions[0].model);
  const [apiKey, setApiKey] = useState("");
  const selectedProvider = providerOptions.find((option) => option.value === providerType);
  const isCustomProvider = providerType === "openai-compatible";
  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedProvider) return;
    const configuredModel = isCustomProvider ? model.trim() : selectedProvider.model;
    const configuredBaseUrl = baseUrl.trim() || selectedProvider.baseUrl;
    const displayName = isCustomProvider ? configuredModel : selectedProvider.displayName;
    try {
      await onSave({
        alias: `${providerAliasFor(selectedProvider, configuredBaseUrl)}-${configuredModel}`.replace(/[^a-z0-9.-]+/gi, "-"),
        displayName,
        providerAlias: providerAliasFor(selectedProvider, configuredBaseUrl),
        providerType,
        model: configuredModel,
        baseUrl: configuredBaseUrl,
        apiKey: apiKey.trim() || undefined,
        apiKeyEnv: undefined,
        supportsTools: true,
        supportsThinking: selectedProvider.supportsThinking
      });
      setApiKey("");
    } catch {
      // SettingsOverlay already exposes the exact validation or save error.
    }
  };
  return (
    <div className="settings-sections">
      <section><h3>已配置模型</h3>{models.map((configuredModel) => (
        <button className={`model-setting-row${configuredModel.alias === runtime?.modelAlias ? " is-selected" : ""}`} key={configuredModel.alias} onClick={() => onChange(configuredModel.alias, configuredModel.defaultThinking)} type="button">
          <span><strong>{configuredModel.displayName}</strong><small>{configuredModel.provider} · {configuredModel.model}</small></span><span>{configuredModel.supportsTools === true ? "支持工具" : configuredModel.supportsTools === false ? "不支持工具" : "工具能力未声明"}{configuredModel.efforts.length ? " · 支持推理强度" : ""}</span>
        </button>
      ))}{!models.length ? <div className="settings-empty">还没有模型。请在下方新增配置。</div> : null}</section>
      <section>
        <h3>添加服务商</h3>
        <form className="model-configuration-form" onSubmit={(event) => { void save(event); }}>
          <label><span>服务商</span><select onChange={(event) => { const next = providerOptions.find((option) => option.value === event.target.value); if (!next) return; setProviderType(next.value); setBaseUrl(next.baseUrl); setModel(next.model); }} value={providerType}>{providerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{selectedProvider?.description}</small></label>
          <label><span>API Key{selectedProvider?.requiresApiKey ? "" : "（本地服务无需填写）"}</span><input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={selectedProvider?.requiresApiKey ? "粘贴 API Key" : "无需填写"} required={selectedProvider?.requiresApiKey} type="password" value={apiKey} /><small>保存后不会再次显示</small></label>
          {isCustomProvider ? <label><span>模型 ID</span><input onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-5.2" required value={model} /></label> : <div className="model-configuration-default"><span>默认模型</span><strong>{selectedProvider?.displayName}</strong><small>可在添加后切换或覆盖模型</small></div>}
          <details className="model-configuration-advanced">
            <summary>高级设置</summary>
            <label><span>Base URL</span><input onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required={isCustomProvider} type="url" value={baseUrl} /><small>{isCustomProvider ? "自定义服务必须填写接口地址" : "默认使用服务商官方接口；仅在代理或中转时修改"}</small></label>
          </details>
          <p>保存后立即设为默认模型。API Key 只保存在当前项目的 <code>agent.config.json</code>。</p>
          <div className="settings-button-row"><button className="is-primary" type="submit">保存并开始使用</button></div>
        </form>
      </section>
    </div>
  );
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

function SettingsAgent({ disabled, onCompact }: { disabled: boolean; onCompact(): void }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>会话上下文</h3><div className="setting-row"><span><strong>压缩当前会话</strong><small>调用现有 ContextRuntime 的真实压缩流程</small></span><button disabled={disabled} onClick={onCompact} type="button">立即压缩</button></div></section></div>;
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
