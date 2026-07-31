/**
 * 普通 Agent Loop 的运行预算。
 *
 * 配置解析集中在这里，避免 AgentSession、Completion Gate 和后续 Coordinator 分别解释
 * maxSteps。旧字段暂时保留：maxSteps 映射软限制，maxTaskSteps 映射硬限制。
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
  const hardStepLimit = agent.hardStepLimit ?? agent.maxTaskSteps;
  return {
    // 旧配置允许 maxSteps 大于 maxTaskSteps；统一 Loop 下软限制不能晚于硬停止点。
    softStepLimit: Math.min(agent.softStepLimit ?? agent.maxSteps, hardStepLimit),
    hardStepLimit,
    maxToolCalls: agent.maxToolCalls ?? 512,
    // Provider 当前没有配置重试时保持现状：除首次请求外不额外重试。
    maxProviderRetries: agent.maxProviderRetries ?? 0,
    maxCompletionContinuations: agent.maxCompletionContinuations ?? 3,
    maxRepeatedActions: agent.maxRepeatedActions ?? 3
  };
}
