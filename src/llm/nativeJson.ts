import type { AgentMessage, AgentModel, AgentUsage } from "../agent/core/types.js";

export interface NativeTextGenerationOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface NativeTextGenerationResult {
  text: string;
  usage?: AgentUsage;
}

/** Small native helper for structured side tasks such as memory and compaction. */
export async function generateNativeText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions = {}
): Promise<NativeTextGenerationResult> {
  let text = "";
  let usage: AgentUsage | undefined;
  const streamModel = model.streamSimple?.bind(model) ?? model.stream.bind(model);
  for await (const event of await streamModel({ messages, tools: [] }, options)) {
    options.signal?.throwIfAborted();
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "finish") usage = event.usage;
    else if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
  }
  return { text, usage };
}

export function nativeJsonMessages(systemPrompt: string, prompt: string): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `${systemPrompt}\n\n${prompt}` }] }
  ];
}

export function parseNativeJson(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  return JSON.parse(normalized);
}
