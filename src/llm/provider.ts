/**
 * LLM provider 契约模块。
 *
 * Agent loop 不直接依赖某个模型厂商，而是通过这里定义的 chat、streamChat、命令分析和
 * 文件编辑建议接口工作。Mock provider 与 OpenAI 兼容 provider 都必须遵守这组输入输出结构。
 */
import type { JsonObjectSchema } from "../tools/schema.js";

export interface ChatMessage {
  // toolCalls 只用于 assistant 消息，确保 OpenAI-compatible API 能看到 tool result 的前置 tool_calls。
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: LLMToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
}

export interface LLMToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface LLMRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
}

export interface CommandAnalysisInput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileEditInput {
  instruction: string;
  path: string;
  content: string;
}

export interface FileEditProposal {
  oldText: string;
  newText: string;
  explanation: string;
}

export interface LLMProvider {
  // createResponse 是 Agent Loop 使用的结构化接口；旧 provider 没实现时会退回 chat/streamChat。
  createResponse?(request: LLMRequest): Promise<LLMResponse>;
  // chat 返回完整文本；streamChat 可选，TUI 存在时用于增量渲染。
  chat(messages: ChatMessage[]): Promise<string>;
  streamChat?(messages: ChatMessage[], onDelta: (delta: string) => void, options?: { signal?: AbortSignal }): Promise<string>;
  // 以下两个方法把常见 agent 能力抽象到 provider，避免 loop 里拼具体 prompt。
  analyzeCommandResult(input: CommandAnalysisInput): Promise<string>;
  proposeFileEdit(input: FileEditInput): Promise<FileEditProposal>;
}
