/**
 * Composer 模型选择器。
 *
 * 主菜单只负责搜索、按 Provider 分组和选择模型；当前悬停/聚焦模型的真实元信息与推理强度
 * 放在相邻详情面板中，避免把所有配置塞进每一行，也不复制上层的模型状态。
 */
import { useEffect, useMemo, useState } from "react";
import type { ModelChoice, ThinkingSelection } from "../../../../../llm/ModelManager.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { thinkingLabel } from "./composerLabels.js";

interface ModelGroup {
  key: string;
  label: string;
  iconTone: string;
  models: ModelChoice[];
}

export function ModelMenu({
  models,
  currentAlias,
  currentThinking,
  open,
  onChange,
  onConfigureModels
}: {
  models: ModelChoice[];
  currentAlias?: string;
  currentThinking: ThinkingSelection;
  open: boolean;
  onChange(alias: string, thinking: ThinkingSelection): void;
  onConfigureModels(): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [query, setQuery] = useState("");
  const [detailAlias, setDetailAlias] = useState<string>();
  const firstModelAlias = models[0]?.alias;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    setDetailAlias(currentAlias ?? firstModelAlias);
  }, [currentAlias, firstModelAlias, open]);

  const groups = useMemo(() => groupModels(models, query), [models, query]);
  const visibleModels = useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const detailModel = visibleModels.find((model) => model.alias === detailAlias)
    ?? visibleModels.find((model) => model.alias === currentAlias)
    ?? visibleModels[0];

  if (!presence.present) return null;

  return (
    <div className={`t-dropdown composer-popover model-menu ${presenceClass(presence.phase)}`} data-origin="bottom-right">
      {detailModel ? (
        <ModelDetailPanel
          currentAlias={currentAlias}
          currentThinking={currentThinking}
          model={detailModel}
          onChange={onChange}
        />
      ) : null}
      <div aria-label="选择模型" className="model-menu-main" role="menu">
        <label className="model-search">
          <Icon name="search" size={14} />
          <input
            aria-label="搜索模型"
            autoFocus={open}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型…"
            value={query}
          />
        </label>
        <div className="model-options-scroll">
          {groups.length ? groups.map((group) => (
            <div className="model-group" key={group.key}>
              <div className="model-group-heading">{group.label}</div>
              {group.models.map((model) => {
                const selected = model.alias === currentAlias;
                const rowThinking = selected ? currentThinking : model.defaultThinking;
                return (
                  <button
                    aria-checked={selected}
                    className={`menu-option model-option${selected ? " is-selected" : ""}`}
                    key={model.alias}
                    onClick={() => onChange(model.alias, rowThinking)}
                    onFocus={() => setDetailAlias(model.alias)}
                    onPointerEnter={() => setDetailAlias(model.alias)}
                    role="menuitemradio"
                    title={model.model}
                    type="button"
                  >
                    <span className="model-option-leading">
                      <span className="model-option-brand"><ProviderBrandGlyph type={group.iconTone} /></span>
                      <span className="model-option-copy">
                        <strong>{model.displayName}</strong>
                        {model.efforts.length ? <small>{thinkingLabel(rowThinking)}</small> : null}
                      </span>
                    </span>
                    <span className="model-option-check">{selected ? <Icon name="check" size={14} /> : null}</span>
                  </button>
                );
              })}
            </div>
          )) : <div className="menu-empty">没有匹配的模型</div>}
        </div>
        <div className="model-menu-footer">
          <button onClick={onConfigureModels} role="menuitem" type="button">
            <Icon name="add" size={14} />
            <span>添加或管理模型</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelDetailPanel({ model, currentAlias, currentThinking, onChange }: {
  model: ModelChoice;
  currentAlias?: string;
  currentThinking: ThinkingSelection;
  onChange(alias: string, thinking: ThinkingSelection): void;
}): React.JSX.Element {
  const catalog = catalogForConnection(
    { provider: model.provider, providerType: model.providerType },
    model.baseUrl
  );
  const provider = catalog?.label ?? providerLabel(model.provider);
  const selectedThinking = model.alias === currentAlias ? currentThinking : model.defaultThinking;
  const allowsOff = model.thinkingLevelMap.off !== undefined && model.thinkingLevelMap.off !== null;
  const efforts: ThinkingSelection[] = [
    ...(allowsOff ? ["off" as const] : []),
    ...model.efforts
  ];

  return (
    <aside aria-label={`${model.displayName} 模型设置`} className="model-detail-panel" role="group">
      <header>
        <strong>{model.displayName}</strong>
        <span>{model.description ?? model.model}</span>
      </header>
      {efforts.length ? (
        <div className="model-detail-section">
          <div className="model-detail-label">推理强度</div>
          <div className="model-effort-options">
            {efforts.map((effort) => (
              <button
                aria-checked={effort === selectedThinking}
                className={effort === selectedThinking ? "is-selected" : ""}
                key={effort}
                onClick={() => onChange(model.alias, effort)}
                role="menuitemradio"
                type="button"
              >
                <span>{thinkingLabel(effort)}</span>
                {effort === selectedThinking ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <footer>
        <span>来源：{provider}</span>
        {model.contextWindow ? <span>{formatTokenCount(model.contextWindow)} 上下文</span> : null}
        {model.supportsTools ? <span>支持工具</span> : null}
      </footer>
    </aside>
  );
}

function groupModels(models: ModelChoice[], query: string): ModelGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const catalog = catalogForConnection(
      { provider: model.provider, providerType: model.providerType },
      model.baseUrl
    );
    const label = catalog?.label ?? providerLabel(model.provider);
    const haystack = `${model.displayName} ${model.model} ${model.provider} ${label}`.toLocaleLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
    const key = `${model.providerType}:${model.provider}`;
    const group = groups.get(key) ?? {
      key,
      label,
      iconTone: catalog?.iconTone ?? "compatible",
      models: []
    };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Google Gemini",
    kimi: "Kimi",
    moonshot: "Moonshot",
    ollama: "Ollama",
    openai: "OpenAI",
    qwen: "Qwen"
  };
  return labels[provider.toLocaleLowerCase()] ?? provider;
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: tokens >= 1_000_000 ? 1 : 0
  }).format(tokens).toLocaleLowerCase();
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
