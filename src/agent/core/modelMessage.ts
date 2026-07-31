/**
 * Biny 持久化与 provider 上下文共用的模型消息协议。
 *
 * 这是 Agent Runtime 自己的类型，不依赖任何模型 SDK。未知 provider 元数据保留在
 * 分片对象上，保证会话恢复不会因为某个 provider 增加字段而丢失内容。
 */
export type ModelMessagePart =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "reasoning"; text: string; providerOptions?: Record<string, unknown>; providerMetadata?: Record<string, unknown>; [key: string]: unknown }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; [key: string]: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown; isError?: boolean; [key: string]: unknown }
  | { type: "file"; data: unknown; mediaType?: string; filename?: string; [key: string]: unknown }
  | { type: "image"; image?: unknown; data?: unknown; mediaType?: string; [key: string]: unknown };

export type ModelMessageContent = string | ModelMessagePart[];

export type ModelMessage =
  | { role: "system"; content: ModelMessageContent }
  | { role: "user"; content: ModelMessageContent }
  | { role: "assistant"; content: ModelMessageContent }
  | { role: "tool"; content: ModelMessagePart[] };
