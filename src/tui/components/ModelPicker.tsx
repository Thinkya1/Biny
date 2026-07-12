import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ModelChoice, ThinkingSelection } from "../../llm/ModelManager.js";
import { tuiColors } from "../theme/index.js";

const pageSize = 6;

export interface ModelSelection {
  alias: string;
  thinking: ThinkingSelection;
}

export interface ModelPickerProps {
  models: ModelChoice[];
  currentAlias: string;
  currentThinking: ThinkingSelection;
  onSelect: (selection: ModelSelection) => void;
  onCancel: () => void;
}

export function ModelPicker({ models, currentAlias, currentThinking, onSelect, onCancel }: ModelPickerProps): React.ReactElement {
  const initialIndex = Math.max(0, models.findIndex((model) => model.alias === currentAlias));
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [thinkingOverrides, setThinkingOverrides] = useState<Record<string, ThinkingSelection>>({});
  const filtered = useMemo(() => filterModelChoices(models, query), [models, query]);
  const queryRef = useRef(query);
  const selectedIndexRef = useRef(selectedIndex);
  const thinkingOverridesRef = useRef(thinkingOverrides);
  const selected = filtered[Math.min(selectedIndex, Math.max(0, filtered.length - 1))];

  useEffect(() => {
    const next = Math.min(selectedIndexRef.current, Math.max(0, filtered.length - 1));
    selectedIndexRef.current = next;
    setSelectedIndex(next);
  }, [filtered.length]);

  useInput((input, key) => {
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
      const currentModels = filterModelChoices(models, queryRef.current);
      if (!currentModels.length) return;
      const direction = key.upArrow ? -1 : 1;
      const next = (selectedIndexRef.current + direction + currentModels.length) % currentModels.length;
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return;
    }
    if (key.pageUp || key.pageDown) {
      const currentModels = filterModelChoices(models, queryRef.current);
      if (!currentModels.length) return;
      const direction = key.pageUp ? -pageSize : pageSize;
      const next = Math.min(Math.max(selectedIndexRef.current + direction, 0), currentModels.length - 1);
      selectedIndexRef.current = next;
      setSelectedIndex(next);
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const currentModels = filterModelChoices(models, queryRef.current);
      const currentModel = currentModels[Math.min(selectedIndexRef.current, Math.max(0, currentModels.length - 1))];
      if (!currentModel) return;
      const segments = thinkingSegments(currentModel);
      if (segments.length < 2) return;
      const current = effectiveThinking(currentModel, currentAlias, currentThinking, thinkingOverridesRef.current);
      const index = Math.max(0, segments.indexOf(current));
      const next = Math.min(Math.max(index + (key.leftArrow ? -1 : 1), 0), segments.length - 1);
      const thinking = segments[next];
      if (thinking) {
        const overrides = { ...thinkingOverridesRef.current, [currentModel.alias]: thinking };
        thinkingOverridesRef.current = overrides;
        setThinkingOverrides(overrides);
      }
      return;
    }
    if (key.return) {
      const currentModels = filterModelChoices(models, queryRef.current);
      const currentModel = currentModels[Math.min(selectedIndexRef.current, Math.max(0, currentModels.length - 1))];
      if (!currentModel) return;
      onSelect({
        alias: currentModel.alias,
        thinking: effectiveThinking(currentModel, currentAlias, currentThinking, thinkingOverridesRef.current)
      });
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
    if (nextInput.length !== 1) return;
    const next = `${queryRef.current}${nextInput}`;
    queryRef.current = next;
    selectedIndexRef.current = 0;
    setQuery(next);
    setSelectedIndex(0);
  });

  const selectedPosition = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
  const pageStart = Math.floor(selectedPosition / pageSize) * pageSize;
  const visibleModels = filtered.slice(pageStart, pageStart + pageSize);
  const selectedThinking = selected
    ? effectiveThinking(selected, currentAlias, currentThinking, thinkingOverrides)
    : "off";

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="single"
      borderColor={tuiColors.primary}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text color={tuiColors.primary} bold>
        Select a model<Text color={tuiColors.textMuted}> (type to search)</Text>
      </Text>
      <Text color={tuiColors.textMuted}>↑↓ navigate · ←→ effort · Enter · Esc</Text>
      {query ? <Text><Text color={tuiColors.primary}>Search: </Text>{query}</Text> : <Text> </Text>}
      {visibleModels.length === 0 ? <Text color={tuiColors.textMuted}>No matches</Text> : null}
      {visibleModels.map((model, index) => {
        const absoluteIndex = pageStart + index;
        const isSelected = absoluteIndex === selectedPosition;
        const isCurrent = model.alias === currentAlias;
        return (
          <Text key={model.alias} color={isSelected ? tuiColors.primary : tuiColors.text} bold={isSelected} wrap="truncate-end">
            <Text color={isSelected ? tuiColors.primary : tuiColors.textDim}>{isSelected ? "❯ " : "  "}</Text>
            {model.displayName}
            <Text color={tuiColors.textMuted}>  {model.provider}</Text>
            {isCurrent ? <Text color={tuiColors.success}> ← current</Text> : null}
          </Text>
        );
      })}
      {filtered.length > pageSize ? (
        <Text color={tuiColors.textMuted}>{String(selectedPosition + 1)} / {String(filtered.length)}</Text>
      ) : null}
      <Text> </Text>
      <Text color={tuiColors.textMuted}>
        Thinking{selected && thinkingSegments(selected).length > 1 ? " (←→ to switch)" : ""}
      </Text>
      {selected ? <ThinkingControl model={selected} active={selectedThinking} /> : null}
    </Box>
  );
}

export function filterModelChoices(models: ModelChoice[], query: string): ModelChoice[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((model) => [
    model.alias,
    model.displayName,
    model.provider,
    model.providerType,
    model.model
  ].some((value) => value.toLowerCase().includes(normalized)));
}

export function thinkingSegments(model: ModelChoice): ThinkingSelection[] {
  return model.efforts.length ? ["off", ...model.efforts] : ["off"];
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

function ThinkingControl({ model, active }: { model: ModelChoice; active: ThinkingSelection }): React.ReactElement {
  if (!model.efforts.length) {
    return (
      <Text>
        <Text color={tuiColors.textMuted}> On (Unsupported) </Text>
        <Text color={tuiColors.primary} bold>[ Off ]</Text>
      </Text>
    );
  }
  return (
    <Text>
      {thinkingSegments(model).map((thinking, index) => (
        <React.Fragment key={thinking}>
          {index > 0 ? " " : ""}
          <Text color={thinking === active ? tuiColors.primary : tuiColors.text} bold={thinking === active}>
            {thinking === active ? `[ ${thinkingLabel(thinking)} ]` : ` ${thinkingLabel(thinking)} `}
          </Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

function thinkingLabel(thinking: ThinkingSelection): string {
  return thinking.charAt(0).toUpperCase() + thinking.slice(1);
}
