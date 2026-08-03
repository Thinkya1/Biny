import type { ModelChoice, ThinkingSelection } from "../llm/ModelManager.js";

export interface ModelThinkingOption {
  value: ThinkingSelection;
  label: string;
  description: string;
}

const thinkingLabels: Record<ThinkingSelection, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

const thinkingDescriptions: Record<ThinkingSelection, string> = {
  off: "Disable the model's optional reasoning control",
  minimal: "Fast responses with lighter reasoning",
  low: "Faster responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for complex problems"
};

/**
 * 选择器只展示当前模型声明的 effort；这些名称是模型/Provider 的能力 token，
 * 不是跨模型可比较的真实推理程度。
 */
export function modelThinkingOptions(model: Pick<ModelChoice, "efforts">): ModelThinkingOption[] {
  return model.efforts.map((value) => ({
    value,
    label: thinkingLabels[value],
    description: thinkingDescriptions[value]
  }));
}
