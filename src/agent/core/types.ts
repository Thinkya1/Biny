/**
 * Biny 自有 Agent Runtime 的基础协议。
 *
 * 这里不依赖任何模型 SDK。Provider 只需要把自己的流式响应归一化成
 * `ModelStreamEvent`，Agent Loop 就可以独立处理消息、工具和事件生命周期。
 */
import type { JsonSchema } from "../../tools/schema.js";

export type AgentTextContent = { type: "text"; text: string };
export type AgentImageContent = { type: "image"; data: string; mimeType: string };
export type AgentReasoningContent = {
  type: "reasoning";
  text: string;
  providerMetadata?: Record<string, unknown>;
};
export type AgentToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  invalid?: boolean;
};
export type AgentToolResultContent = AgentTextContent | AgentImageContent;

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage;

export interface AgentUserMessage {
  role: "user";
  content: string | Array<AgentTextContent | AgentImageContent>;
  timestamp?: number;
}

export interface AgentAssistantMessage {
  role: "assistant";
  content: Array<AgentTextContent | AgentReasoningContent | AgentToolCallContent>;
  stopReason?: AgentStopReason;
  usage?: AgentUsage;
  errorMessage?: string;
  timestamp?: number;
}

export interface AgentToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: AgentToolResultContent[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
}

export type AgentStopReason = "stop" | "tool-calls" | "length" | "error" | "aborted" | "other";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentToolResult<TDetails = unknown> {
  content: AgentToolResultContent[];
  details?: TDetails;
  isError?: boolean;
  /** 当前工具批次完成后是否可以跳过下一次模型请求。 */
  terminate?: boolean;
  usage?: AgentUsage;
}

export type AgentToolUpdate = (update: AgentToolResult) => void;

export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: JsonSchema;
  executionMode?: "parallel" | "sequential";
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdate
  ): Promise<AgentToolResult>;
}

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface ModelStreamContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface ModelStreamOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  reasoning?: string;
  providerOptions?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AgentModel {
  provider: string;
  modelId: string;
  supportsTools?: boolean;
  stream(
    context: ModelStreamContext,
    options?: ModelStreamOptions
  ): Promise<AsyncIterable<ModelStreamEvent>>;
}

export type ModelStreamEvent =
  | { type: "start" }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-start"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-end"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool-call"; id: string; name: string; arguments: Record<string, unknown>; invalid?: boolean }
  | { type: "finish"; reason: AgentStopReason; usage?: AgentUsage }
  | { type: "error"; error: unknown };

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentAssistantMessage; toolResults: AgentToolResultMessage[]; messages: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentAssistantMessage; event: ModelStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; update: AgentToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult }
  | { type: "error"; error: string; fatal: boolean };

export interface AgentLoopTurnContext {
  message: AgentAssistantMessage;
  toolResults: AgentToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

export interface AgentLoopConfig {
  model: AgentModel;
  tools: AgentTool[];
  modelOptions?: ModelStreamOptions;
  maxSteps: number;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  shouldStopAfterTurn?: (context: AgentLoopTurnContext) => boolean | Promise<boolean>;
  beforeToolCall?: (context: {
    assistantMessage: AgentAssistantMessage;
    toolCall: AgentToolCallContent;
    args: Record<string, unknown>;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (context: {
    assistantMessage: AgentAssistantMessage;
    toolCall: AgentToolCallContent;
    args: Record<string, unknown>;
    result: AgentToolResult;
    context: AgentContext;
  }, signal?: AbortSignal) => Promise<Partial<AgentToolResult> | undefined>;
  toolExecution?: "parallel" | "sequential";
}
