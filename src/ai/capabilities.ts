/**
 * 模型能力与上下文预算推导。
 *
 * 配置里能力字段大多是可选的，这里负责把「配置 + 模型 ID 启发式 + 默认值」收敛成确定的
 * 能力集合、上下文预算和思考档位，让上层不必到处写兜底判断。
 */
import type { ModelAliasConfig, ModelThinkingConfig, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";
import type { ModelCapabilities, ModelContextBudget } from "./types.js";

export const defaultModelContextWindow = 32_768;
export const defaultModelOutputTokens = 8_192;

/**
 * 模型级 canonical map。它表达的是 provider 可接受的参数，而不是模型真实“思考程度”。
 * 旧配置只有 `thinking`/`reasoning` 时，在这里转换为同一份 map，避免上层继续分叉。
 */
export function modelThinkingLevelMap(model: ModelAliasConfig): ThinkingLevelMap {
  if (model.thinkingLevelMap) return { ...model.thinkingLevelMap };
  const reasoning = model.reasoning ?? model.thinking;
  if (!reasoning) return {};
  const map: ThinkingLevelMap = { off: "none" };
  for (const effort of reasoning.efforts) map[effort] = reasoning.mapping?.[effort] ?? effort;
  return map;
}

/** `reasoning` 是新字段，`thinking` 是旧配置名；两者都落到 canonical map 上。 */
export function modelReasoningConfig(model: ModelAliasConfig): ModelThinkingConfig | undefined {
  const map = modelThinkingLevelMap(model);
  const efforts = Object.entries(map)
    .filter(([level, native]) => level !== "off" && native !== null)
    .map(([level]) => level as ReasoningEffort);
  if (!efforts.length) return undefined;

  const legacy = model.reasoning ?? model.thinking;
  const defaultEffort = legacy?.defaultEffort && efforts.includes(legacy.defaultEffort)
    ? legacy.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0]!;
  const mapping = Object.fromEntries(
    efforts.map((effort) => [effort, map[effort] ?? effort])
  ) as Partial<Record<ReasoningEffort, string>>;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: legacy?.budgetTokens
  };
}

/**
 * 已知具备可调推理档位的模型家族。
 *
 * OpenAI 兼容端点（尤其是中转站和自建网关）几乎都不返回 `reasoning_efforts`，
 * 只按响应字段判断的话，grok-4.5、GPT-5、Claude 4 这类模型都会被当成不支持
 * 思考，界面上只剩一个「默认」档。所以在服务商没有声明时按模型 ID 兜底推断。
 *
 * 这是一张需要维护的启发式清单：宁可漏判（退回单一默认档，行为与今天一致），
 * 也不要误判（给不支持的模型发 reasoning 参数，严格的服务端会直接报错）。
 */
const reasoningModelPatterns: RegExp[] = [
  /^o[1341](?![a-z0-9])/iu,                       // OpenAI o1 / o3 / o4
  /\bgpt-5/iu,
  /\bgrok-(?:3-mini|[4-9])/iu,
  /\bclaude-(?:sonnet-|opus-|haiku-)?(?:[4-9]|3[.-]7)/iu,
  /\bdeepseek-(?:r1|reasoner)/iu,
  /\bdeepseek-v(?:[4-9]|3[.-][1-9])/iu,
  /\bqw[qe]n?3/iu,                                // Qwen3 / QwQ
  /\bglm-(?:[5-9]|4[.-][5-9]|z1)/iu,
  /\bkimi-k(?:[2-9]|1[.-]5)/iu,
  /\bminimax-m[1-9]/iu,
  /\bgemini-(?:[3-9]|2[.-]5)/iu,
  /\bhunyuan-t[1-9]|\bhy[1-9]|\btc-code/iu,
  /\bstep-[3-9]/iu,
  /\bmimo-v?[2-9]/iu,
  /\bernie-x[1-9]/iu,
  /\bnemotron/iu,
  /\bgpt-oss/iu,
  /(?:^|[-/])(?:thinking|reasoner|reasoning)(?:$|[-.])/iu
];

/**
 * 服务商没有声明推理档位时，按模型 ID 推断。返回空数组表示按不支持处理。
 */
export function inferReasoningEfforts(modelId: string): ReasoningEffort[] {
  const normalized = modelId.trim();
  if (!normalized) return [];
  // 只看最后一段，避免聚合服务的厂商前缀（如 `openai/gpt-4o-mini`）误伤。
  const identifier = normalized.split("/").pop() ?? normalized;
  if (/^deepseek-v4-flash$/iu.test(identifier)) return [];
  if (/^deepseek-v4-pro$/iu.test(identifier)) return ["low", "medium", "high"];
  return reasoningModelPatterns.some((pattern) => pattern.test(identifier)) ? ["high", "max"] : [];
}

/** 把目录/桌面配置里的支持提示转换成模型级 canonical map。 */
export function thinkingLevelMapForModel(modelId: string, supportsThinking = true): ThinkingLevelMap {
  if (!supportsThinking || /^deepseek-v4-flash$/iu.test(modelId.trim().split("/").pop() ?? modelId)) {
    return { off: "none" };
  }
  const efforts = inferReasoningEfforts(modelId);
  const resolved = efforts.length ? efforts : ["high", "max"] as ReasoningEffort[];
  return {
    off: "none",
    ...Object.fromEntries(resolved.map((effort) => [effort, effort]))
  };
}

/**
 * 汇总模型能力。默认按「支持工具、支持流式」处理，因为绝大多数模型都支持，配置里显式
 * 关掉才当作不支持；reasoning 则以是否配了思考参数为准。
 */
export function modelCapabilities(model: ModelAliasConfig): ModelCapabilities {
  const reasoning = modelReasoningConfig(model);
  return {
    tools: model.capabilities?.tools ?? model.supportsTools ?? true,
    reasoning: model.capabilities?.reasoning ?? reasoning !== undefined,
    vision: model.capabilities?.vision ?? false,
    audio: model.capabilities?.audio ?? false,
    streaming: model.capabilities?.streaming ?? true
  };
}

/**
 * 上下文预算以模型自身的上下文窗口为准：窗口减去输出预留就是可用输入预算。
 * `configuredMaxInputTokens` 只是可选的额外上限，没配就完全按模型能力走。
 */
export function modelContextBudget(
  model: ModelAliasConfig,
  configuredMaxInputTokens: number | undefined,
  modelAlias?: string
): ModelContextBudget {
  const maxOutputTokens = model.maxOutputTokens;
  // 没声明窗口时按「输入上限 + 输出预留」反推，至少给到默认窗口。
  const contextWindow = model.contextWindow
    ?? Math.max(defaultModelContextWindow, (configuredMaxInputTokens ?? 0) + (maxOutputTokens ?? defaultModelOutputTokens));
  // 输出预留最多占窗口的 1/4：模型声明的 maxOutputTokens 可能很大（如 64k），
  // 全额预留会把输入预算压到不可用。
  const outputReserve = Math.min(
    maxOutputTokens ?? defaultModelOutputTokens,
    Math.max(2_048, Math.floor(contextWindow * 0.25))
  );
  // 无论怎么算都至少留 2k 输入，否则一次对话都发不出去。
  const availableInputTokens = Math.max(2_048, contextWindow - outputReserve);
  return {
    modelAlias,
    contextWindow,
    maxInputTokens: configuredMaxInputTokens === undefined
      ? availableInputTokens
      : Math.max(2_048, Math.min(configuredMaxInputTokens, availableInputTokens)),
    maxOutputTokens
  };
}

/** 把内部档位名映射成服务商认识的取值；没配映射就原样下发。 */
export function nativeReasoningEffort(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): string {
  const native = modelThinkingLevelMap(model)[effort];
  return native ?? modelReasoningConfig(model)?.mapping?.[effort] ?? effort;
}

/** 按思考预算 token 计费的协议（如 Anthropic）需要具体数值，这里给出各档默认值。 */
export function reasoningBudgetTokens(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): number {
  return modelReasoningConfig(model)?.budgetTokens?.[effort]
    ?? (effort === "max" || effort === "xhigh" ? 8_192 : effort === "high" ? 4_096 : 2_048);
}
