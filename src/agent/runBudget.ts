/**
 * 普通 Agent Loop 的运行预算。
 *
 * 配置解析集中在这里，避免 AgentSession、Completion Gate 和 Coordinator 分别解释预算。
 */
import type { AgentConfig } from "../config/schema.js";

export interface RunBudget {
  softStepLimit: number;
  hardStepLimit: number;
  maxToolCalls: number;
  maxProviderRetries: number;
  maxCompletionContinuations: number;
  maxRepeatedActions: number;
}

export function resolveRunBudget(agent: AgentConfig["agent"]): RunBudget {
  return {
    softStepLimit: Math.min(agent.softStepLimit, agent.hardStepLimit),
    hardStepLimit: agent.hardStepLimit,
    maxToolCalls: agent.maxToolCalls ?? 512,
    // Provider 当前没有配置重试时保持现状：除首次请求外不额外重试。
    maxProviderRetries: agent.maxProviderRetries ?? 0,
    maxCompletionContinuations: agent.maxCompletionContinuations ?? 3,
    maxRepeatedActions: agent.maxRepeatedActions ?? 3
  };
}
