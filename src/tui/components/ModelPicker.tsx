import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput, type Key } from "ink";
import type { ModelChoice, ThinkingSelection } from "../../llm/ModelManager.js";
import { DialogFrame } from "./DialogFrame.js";
import { tuiColors } from "../theme/index.js";

const pageSize = 6;

export interface ModelSelection {
  alias: string;
  thinking: ThinkingSelection;
}

export interface ReasoningOption {
  value: ThinkingSelection;
  label: string;
  description: string;
}

export interface ModelPickerProps {
  models: ModelChoice[];
  currentAlias: string;
  currentThinking: ThinkingSelection;
  onSelect: (selection: ModelSelection) => void;
  onCancel: () => void;
}

type PickerStage = "models" | "reasoning";

export function ModelPicker({ models, currentAlias, currentThinking, onSelect, onCancel }: ModelPickerProps): React.ReactElement {
  const initialIndex = Math.max(0, models.findIndex((model) => model.alias === currentAlias));
  const [stage, setStage] = useState<PickerStage>("models");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [draftModelAlias, setDraftModelAlias] = useState<string | undefined>(undefined);
  const [thinkingOverrides, setThinkingOverrides] = useState<Record<string, ThinkingSelection>>({});
  const [reasoningIndex, setReasoningIndex] = useState(0);
  const filtered = useMemo(() => filterModelChoices(models, query), [models, query]);
  const queryRef = useRef(query);
  const stageRef = useRef<PickerStage>(stage);
  const selectedIndexRef = useRef(selectedIndex);
  const draftModelAliasRef = useRef(draftModelAlias);
  const thinkingOverridesRef = useRef(thinkingOverrides);
  const reasoningIndexRef = useRef(reasoningIndex);

  useEffect(() => {
    const next = Math.min(selectedIndexRef.current, Math.max(0, filtered.length - 1));
    selectedIndexRef.current = next;
    setSelectedIndex(next);
  }, [filtered.length]);

  useInput((input, key) => {
    if (stageRef.current === "reasoning") {
      handleReasoningInput(input, key);
      return;
    }
    handleModelInput(input, key);
  });

  const selectedPosition = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
  const pageStart = Math.floor(selectedPosition / pageSize) * pageSize;
  const visibleModels = filtered.slice(pageStart, pageStart + pageSize);
  const draftModel = models.find((model) => model.alias === draftModelAlias)
    ?? filtered[selectedPosition];

  if (stage === "reasoning" && draftModel) {
    return (
      <ReasoningPicker
        model={draftModel}
        options={reasoningOptions(draftModel)}
        selectedIndex={reasoningIndex}
        currentAlias={currentAlias}
        currentThinking={currentThinking}
      />
    );
  }

  return (
    <DialogFrame
      title={<>
        Select Model and Effort
        {!query ? <Text color={tuiColors.textMuted}> (type to search)</Text> : null}
      </>}
      subtitle="Access configured model aliases from agent.config.json"
      hint={modelHint(query, filtered.length > pageSize)}
    >
      <Text> </Text>
      {query ? <Text><Text color={tuiColors.primary}>Search: </Text>{query}</Text> : null}
      {visibleModels.length === 0 ? <Text color={tuiColors.textMuted}>No matches</Text> : null}
      {visibleModels.map((model, index) => {
        const absoluteIndex = pageStart + index;
        const isSelected = absoluteIndex === selectedPosition;
        const isCurrent = model.alias === currentAlias;
        return (
          <Text key={model.alias} color={isSelected ? tuiColors.primary : tuiColors.text} bold={isSelected} wrap="truncate-end">
            {isSelected ? "❯ " : "  "}
            {String(absoluteIndex + 1)}. {model.displayName}
            <Text color={tuiColors.textMuted}>  {model.provider}  {modelDescription(model)}</Text>
            {isCurrent ? <Text color={tuiColors.success}> ← current</Text> : null}
          </Text>
        );
      })}
      <Text> </Text>
      {filtered.length > pageSize ? <Text color={tuiColors.textMuted}>{query ? `${String(selectedPosition + 1)} / ${String(filtered.length)}` : `▼ ${String(Math.max(0, filtered.length - visibleModels.length))} more`}</Text> : null}
    </DialogFrame>
  );

  function handleModelInput(input: string, key: Key): void {
    if (key.escape) {
      if (queryRef.current) {
        queryRef.current = "";
        selectedIndexRef.current = initialIndex;
        setQuery("");
        setSelectedIndex(initialIndex);
      } else {
        onCancel();
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (!filtered.length) return;
      const direction = key.upArrow ? -1 : 1;
      const next = (selectedIndexRef.current + direction + filtered.length) % filtered.length;
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return;
    }
    if (key.pageUp || key.pageDown) {
      if (!filtered.length) return;
      const direction = key.pageUp ? -pageSize : pageSize;
      const next = Math.min(Math.max(selectedIndexRef.current + direction, 0), filtered.length - 1);
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return;
    }
    if (key.return) {
      const model = filtered[Math.min(selectedIndexRef.current, Math.max(0, filtered.length - 1))];
      if (!model) return;
      const options = reasoningOptions(model);
      const activeThinking = effectiveThinking(model, currentAlias, currentThinking, thinkingOverridesRef.current);
      const nextReasoningIndex = Math.max(0, options.findIndex((option) => option.value === activeThinking));
      draftModelAliasRef.current = model.alias;
      reasoningIndexRef.current = nextReasoningIndex;
      setDraftModelAlias(model.alias);
      setReasoningIndex(nextReasoningIndex);
      stageRef.current = "reasoning";
      setStage("reasoning");
      return;
    }
    if (key.backspace || key.delete) {
      const next = queryRef.current.slice(0, -1);
      queryRef.current = next;
      selectedIndexRef.current = 0;
      setQuery(next);
      setSelectedIndex(0);
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.home || key.end) return;
    const nextInput = input.replaceAll("\r", "").replaceAll("\n", "");
    if (!nextInput) return;
    const next = `${queryRef.current}${nextInput}`;
    queryRef.current = next;
    selectedIndexRef.current = 0;
    setQuery(next);
    setSelectedIndex(0);
  }

  function handleReasoningInput(_input: string, key: Key): void {
    if (key.escape) {
      stageRef.current = "models";
      setStage("models");
      return;
    }
    const model = models.find((candidate) => candidate.alias === draftModelAliasRef.current);
    if (!model) {
      stageRef.current = "models";
      setStage("models");
      return;
    }
    const options = reasoningOptions(model);
    if (key.upArrow || key.downArrow) {
      if (!options.length) return;
      const direction = key.upArrow ? -1 : 1;
      const next = (reasoningIndexRef.current + direction + options.length) % options.length;
      reasoningIndexRef.current = next;
      setReasoningIndex(next);
      return;
    }
    if (key.pageUp || key.pageDown) {
      if (!options.length) return;
      const direction = key.pageUp ? -pageSize : pageSize;
      const next = Math.min(Math.max(reasoningIndexRef.current + direction, 0), options.length - 1);
      reasoningIndexRef.current = next;
      setReasoningIndex(next);
      return;
    }
    if (key.return) {
      const option = options[reasoningIndexRef.current];
      if (!option) return;
      const overrides = { ...thinkingOverridesRef.current, [model.alias]: option.value };
      thinkingOverridesRef.current = overrides;
      setThinkingOverrides(overrides);
      onSelect({ alias: model.alias, thinking: option.value });
    }
  }
}

export function ReasoningPicker({
  model,
  options,
  selectedIndex,
  currentAlias,
  currentThinking
}: {
  model: ModelChoice;
  options: ReasoningOption[];
  selectedIndex: number;
  currentAlias: string;
  currentThinking: ThinkingSelection;
}): React.ReactElement {
  return (
    <DialogFrame
      title={`Select Reasoning Level for ${model.displayName}`}
      hint="↑↓ navigate · PgUp/PgDn page · Enter confirm · Esc back"
      footer="Press enter to confirm or esc to go back"
    >
      <Text> </Text>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const current = model.alias === currentAlias && option.value === currentThinking;
        const defaultOption = option.value === effectiveDefaultThinking(model);
        const marker = current ? " ← current" : defaultOption ? " ← default" : "";
        return (
          <Text key={option.value} color={selected ? tuiColors.primary : tuiColors.text} bold={selected} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {String(index + 1)}. {option.label}
            <Text color={tuiColors.textMuted}>  {option.description}</Text>
            {marker ? <Text color={current ? tuiColors.success : tuiColors.textDim}>{marker}</Text> : null}
          </Text>
        );
      })}
    </DialogFrame>
  );
}

function modelHint(query: string, hasPages: boolean): string {
  const page = hasPages ? " · PgUp/PgDn page" : "";
  return query
    ? `↑↓ navigate${page} · Enter select · Esc cancel · Backspace clear`
    : `↑↓ navigate${page} · Enter select · Esc cancel`;
}

export function filterModelChoices(models: ModelChoice[], query: string): ModelChoice[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((model) => [
    model.alias,
    model.displayName,
    model.provider,
    model.providerType,
    model.model,
    model.description ?? ""
  ].some((value) => value.toLowerCase().includes(normalized)));
}

export function thinkingSegments(model: ModelChoice): ThinkingSelection[] {
  return model.efforts.length ? ["off", ...model.efforts] : ["off"];
}

export function reasoningOptions(model: ModelChoice): ReasoningOption[] {
  return thinkingSegments(model).map((value) => ({
    value,
    label: thinkingLabel(value),
    description: reasoningDescription(value)
  }));
}

function effectiveThinking(
  model: ModelChoice,
  currentAlias: string,
  currentThinking: ThinkingSelection,
  overrides: Record<string, ThinkingSelection>
): ThinkingSelection {
  const draft = overrides[model.alias]
    ?? (model.alias === currentAlias ? currentThinking : model.defaultThinking);
  const segments = thinkingSegments(model);
  return segments.includes(draft) ? draft : segments[0] ?? "off";
}

function effectiveDefaultThinking(model: ModelChoice): ThinkingSelection {
  const segments = thinkingSegments(model);
  return segments.includes(model.defaultThinking) ? model.defaultThinking : segments[0] ?? "off";
}

function modelDescription(model: ModelChoice): string {
  return model.description ?? (model.efforts.length ? "Configurable reasoning model" : "Configured model");
}

function reasoningDescription(thinking: ThinkingSelection): string {
  if (thinking === "off") return "Disable extended reasoning";
  if (thinking === "max") return "Maximum reasoning depth for the hardest problems";
  return "Greater reasoning depth for complex problems";
}

function thinkingLabel(thinking: ThinkingSelection): string {
  return thinking.charAt(0).toUpperCase() + thinking.slice(1);
}
