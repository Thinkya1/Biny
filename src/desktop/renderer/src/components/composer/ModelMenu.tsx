/**
 * Composer 模型选择器。
 *
 * 主菜单只负责搜索、按 Provider 分组和选择模型；思考级别由相邻的独立菜单负责。
 * 两个菜单都锚定在 footer 控件上，避免选择模型时把输入框或发送区重新排版。
 */
import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";

interface ModelGroup {
  key: string;
  label: string;
  iconTone: string;
  models: ModelChoice[];
}

export function ModelMenu({
  anchorRef,
  models,
  currentAlias,
  open,
  onChange,
  onConfigureModels
}: {
  anchorRef: RefObject<HTMLElement | null>;
  models: ModelChoice[];
  currentAlias?: string;
  open: boolean;
  onChange(alias: string): void;
  onConfigureModels(): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const groups = useMemo(() => groupModels(models, query), [models, query]);

  if (!presence.present) return null;

  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover cindy-composer-popover model-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
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
                return (
                  <button
                    aria-checked={selected}
                    className={`menu-option model-option${selected ? " is-selected" : ""}`}
                    key={model.alias}
                    onClick={() => onChange(model.alias)}
                    role="menuitemradio"
                    type="button"
                  >
                    <span className="model-option-leading">
                      <span className="model-option-brand"><ProviderBrandGlyph type={group.iconTone} /></span>
                      <span className="model-option-copy">
                        <strong>{model.displayName}</strong>
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
    </ComposerPopover>
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

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
