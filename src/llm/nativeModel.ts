/**
 * 原生 Provider transport。
 *
 * 这里只处理 HTTP、SSE 和两个公开消息协议：OpenAI Chat Completions 与 Anthropic
 * Messages。它不依赖模型 SDK，Provider 差异通过请求/响应归一化集中在本文件。
 */
import type {
  AgentAssistantMessage,
  AgentModel,
  AgentTool,
  AgentToolCallContent,
  AgentUsage,
  ModelStreamContext,
  ModelStreamEvent,
  ModelStreamOptions
} from "../agent/core/types.js";
import type { AiProtocol } from "../ai/types.js";
import { isKimiK3Model } from "../ai/capabilities.js";
import { CLAUDE_SUBSCRIPTION_BETA } from "./subscriptionAuth.js";

export interface NativeModelConfig {
  provider: string;
  modelId: string;
  protocol: AiProtocol | "openai-responses";
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  supportsTools?: boolean;
  anthropicAuthMode?: "api-key" | "bearer";
  reasoningProtocol?: "deepseek" | "openai" | "anthropic" | "alibaba" | "moonshotai";
  providerOptions?: Record<string, unknown>;
}

export function createNativeModel(config: NativeModelConfig): AgentModel {
  const fetcher = config.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("This runtime does not provide fetch().");
  return {
    provider: config.provider,
    modelId: config.modelId,
    supportsTools: config.supportsTools !== false,
    stream: async (context, options) => config.protocol === "anthropic"
      ? streamAnthropic(config, fetcher, context, options)
      : config.protocol === "openai-responses"
        ? streamOpenAiResponses(config, fetcher, context, options)
        : streamOpenAi(config, fetcher, context, options)
  };
}

async function* streamOpenAi(
  config: NativeModelConfig,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: openAiMessages(context, config.supportsDeveloperRole === true, config.reasoningProtocol),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (context.tools.length) {
    body.tools = context.tools.map(openAiTool);
    body.tool_choice = "auto";
  }
  if (options.maxOutputTokens !== undefined) {
    body[config.maxTokensField ?? "max_tokens"] = options.maxOutputTokens;
  }
  applyOpenAiReasoning(body, config, options);

  const response = await fetcher(resolveEndpoint(config.baseUrl, "chat/completions"), {
    method: "POST",
    headers: requestHeaders(config, "openai"),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) throw await providerHttpError(response, "OpenAI-compatible provider");
  if (!response.body) throw new Error("OpenAI-compatible provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = await response.json() as Record<string, any>;
    const choice = firstRecord(payload.choices)?.value;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
    const text = readText(message.content);
    if (text) yield { type: "text-delta", text };
    const reasoning = readString(message.reasoning_content) ?? readString(message.reasoning);
    if (reasoning) yield { type: "reasoning-delta", id: "reasoning-0", text: reasoning };
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const raw of calls) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : {};
      const parsed = parseToolArgumentsValue(fn.arguments);
      yield { type: "tool-call", id: readString(raw.id) ?? randomToolCallId(), name: readString(fn.name) ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
    }
    yield { type: "finish", reason: mapOpenAiStopReason(readString(choice?.finish_reason)), usage: isRecord(payload.usage) ? mapOpenAiUsage(payload.usage) : undefined };
    return;
  }
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  for await (const event of readSse(response.body)) {
    if (event.data === "[DONE]") break;
    const payload = parseJson(event.data, "OpenAI-compatible stream event");
    const choice = firstRecord(payload.choices)?.value;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
    if (isRecord(delta)) {
      const text = readText(delta.content);
      if (text) yield { type: "text-delta", text };
      const reasoning = readString(delta.reasoning_content) ?? readString(delta.reasoning);
      if (reasoning) {
        const id = "reasoning-0";
        yield { type: "reasoning-delta", id, text: reasoning };
      }
      const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const raw of deltas) {
        if (!isRecord(raw)) continue;
        const index = typeof raw.index === "number" ? raw.index : toolCalls.size;
        const fn = isRecord(raw.function) ? raw.function : {};
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        current.id = readString(raw.id) ?? current.id;
        current.name = readString(fn.name) ?? current.name;
        current.arguments += readString(fn.arguments) ?? "";
        toolCalls.set(index, current);
      }
    }
    if (isRecord(choice)) {
      finishReason = mapOpenAiStopReason(readString(choice.finish_reason));
    }
    if (isRecord(payload.usage)) usage = mapOpenAiUsage(payload.usage);
  }
  for (const call of [...toolCalls.values()]) {
      const parsed = parseToolArguments(call.arguments);
    yield { type: "tool-call", id: call.id || randomToolCallId(), name: call.name, arguments: parsed.args, invalid: parsed.invalid };
  }
  yield { type: "finish", reason: finishReason, usage };
}

async function* streamAnthropic(
  config: NativeModelConfig,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    model: config.modelId,
    system: context.systemPrompt ? [{ type: "text", text: context.systemPrompt }] : undefined,
    messages: anthropicMessages(context),
    max_tokens: options.maxOutputTokens ?? 4_096,
    stream: true
  };
  if (context.tools.length) body.tools = context.tools.map(anthropicTool);
  applyAnthropicThinking(body, config, options);

  const response = await fetcher(resolveEndpoint(config.baseUrl, "v1/messages"), {
    method: "POST",
    headers: requestHeaders(config, "anthropic"),
    body: JSON.stringify(removeUndefined(body)),
    signal
  });
  if (!response.ok) throw await providerHttpError(response, "Anthropic provider");
  if (!response.body) throw new Error("Anthropic provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = await response.json() as Record<string, any>;
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") yield { type: "text-delta", text: block.text };
      else if (block.type === "thinking" && typeof block.thinking === "string") {
        const providerMetadata = anthropicReasoningMetadata(readString(block.signature));
        yield { type: "reasoning-start", id: "reasoning-0" };
        yield { type: "reasoning-delta", id: "reasoning-0", text: block.thinking, providerMetadata };
        yield { type: "reasoning-end", id: "reasoning-0", providerMetadata };
      } else if (block.type === "tool_use") {
        const parsed = isRecord(block.input) ? { args: block.input, invalid: false } : { args: {}, invalid: true };
        yield { type: "tool-call", id: readString(block.id) ?? randomToolCallId(), name: readString(block.name) ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
      }
    }
    const inputTokens = isRecord(payload.usage) ? readNumber(payload.usage.input_tokens) : undefined;
    const outputTokens = isRecord(payload.usage) ? readNumber(payload.usage.output_tokens) : undefined;
    yield {
      type: "finish",
      reason: mapAnthropicStopReason(readString(payload.stop_reason)),
      usage: { inputTokens, outputTokens, totalTokens: sumUsage({ inputTokens }, outputTokens) }
    };
    return;
  }
  const blocks = new Map<number, { type: string; id?: string; name?: string; input: string; signature?: string }>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  for await (const event of readSse(response.body)) {
    const payload = parseJson(event.data, "Anthropic stream event");
    const eventType = readString(payload.type);
    if (eventType === "message_start" && isRecord(payload.message) && isRecord(payload.message.usage)) {
      usage = { inputTokens: readNumber(payload.message.usage.input_tokens) };
    } else if (eventType === "content_block_start") {
      const index = readNumber(payload.index) ?? blocks.size;
      const block = isRecord(payload.content_block) ? payload.content_block : {};
      const type = readString(block.type) ?? "text";
      const entry = { type, id: readString(block.id), name: readString(block.name), input: "", signature: readString(block.signature) };
      blocks.set(index, entry);
      if (type === "thinking") yield { type: "reasoning-start", id: `reasoning-${String(index)}` };
    } else if (eventType === "content_block_delta") {
      const index = readNumber(payload.index) ?? 0;
      const delta = isRecord(payload.delta) ? payload.delta : {};
      const deltaType = readString(delta.type);
      if (deltaType === "text_delta") {
        const text = readString(delta.text);
        if (text) yield { type: "text-delta", text };
      } else if (deltaType === "thinking_delta") {
        const text = readString(delta.thinking);
        if (text) yield { type: "reasoning-delta", id: `reasoning-${String(index)}`, text };
      } else if (deltaType === "input_json_delta") {
        const block = blocks.get(index);
        if (block) block.input += readString(delta.partial_json) ?? "";
      } else if (deltaType === "signature_delta") {
        const block = blocks.get(index);
        if (block) block.signature = `${block.signature ?? ""}${readString(delta.signature) ?? ""}`;
      }
    } else if (eventType === "content_block_stop") {
      const index = readNumber(payload.index) ?? 0;
      const block = blocks.get(index);
      if (block?.type === "tool_use") {
        const parsed = parseToolArguments(block.input);
        yield { type: "tool-call", id: block.id ?? randomToolCallId(), name: block.name ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
      } else if (block?.type === "thinking") {
        yield { type: "reasoning-end", id: `reasoning-${String(index)}`, providerMetadata: anthropicReasoningMetadata(block.signature) };
      }
    } else if (eventType === "message_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : {};
      finishReason = mapAnthropicStopReason(readString(delta.stop_reason));
      if (isRecord(payload.usage)) {
        usage = { ...usage, outputTokens: readNumber(payload.usage.output_tokens), totalTokens: sumUsage(usage, readNumber(payload.usage.output_tokens)) };
      }
    }
  }
  yield { type: "finish", reason: finishReason, usage };
}

async function* streamOpenAiResponses(
  config: NativeModelConfig,
  fetcher: typeof globalThis.fetch,
  context: ModelStreamContext,
  options: ModelStreamOptions = {}
): AsyncGenerator<ModelStreamEvent, void, void> {
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    model: config.modelId,
    instructions: context.systemPrompt,
    input: responsesInput(context),
    stream: true
  };
  if (context.tools.length) body.tools = context.tools.map(responsesTool);
  if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;
  applyResponsesReasoning(body, config, options);

  const response = await fetcher(resolveEndpoint(config.baseUrl, "responses"), {
    method: "POST",
    headers: requestHeaders(config, "responses"),
    body: JSON.stringify(removeUndefined(body)),
    signal
  });
  if (!response.ok) throw await providerHttpError(response, "OpenAI Responses provider");
  if (!response.body) throw new Error("OpenAI Responses provider returned an empty response body.");

  yield { type: "start" };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    yield* responsesPayloadEvents(await response.json() as Record<string, any>);
    return;
  }

  const calls = new Map<string, { id: string; name: string; arguments: string; emitted: boolean }>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  for await (const event of readSse(response.body)) {
    const payload = parseJson(event.data, "OpenAI Responses stream event");
    const eventType = readString(event.event) ?? readString(payload.type);
    if (eventType === "response.output_text.delta") {
      const text = readString(payload.delta);
      if (text) yield { type: "text-delta", text };
    } else if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") {
      const text = readString(payload.delta);
      if (text) yield { type: "reasoning-delta", id: "reasoning-0", text };
    } else if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item?.type === "function_call") {
        const key = readString(item.call_id) ?? readString(item.id) ?? randomToolCallId();
        const call = calls.get(key) ?? { id: key, name: "", arguments: "", emitted: false };
        call.name = readString(item.name) ?? call.name;
        call.arguments = readString(item.arguments) ?? call.arguments;
        calls.set(key, call);
        if (eventType === "response.output_item.done") {
          const parsed = parseToolArguments(call.arguments);
          call.emitted = true;
          yield { type: "tool-call", id: call.id, name: call.name || "unknown", arguments: parsed.args, invalid: parsed.invalid };
        }
      }
    } else if (eventType === "response.function_call_arguments.delta") {
      const key = readString(payload.call_id) ?? readString(payload.item_id) ?? "";
      if (key) {
        const call = calls.get(key) ?? { id: key, name: "", arguments: "", emitted: false };
        call.arguments += readString(payload.delta) ?? "";
        calls.set(key, call);
      }
    } else if (eventType === "response.function_call_arguments.done") {
      const key = readString(payload.call_id) ?? readString(payload.item_id) ?? "";
      if (key) {
        const call = calls.get(key) ?? { id: key, name: readString(payload.name) ?? "", arguments: "", emitted: false };
        call.arguments = readString(payload.arguments) ?? call.arguments;
        call.name = readString(payload.name) ?? call.name;
        if (!call.emitted) {
          const parsed = parseToolArguments(call.arguments);
          call.emitted = true;
          yield { type: "tool-call", id: call.id, name: call.name || "unknown", arguments: parsed.args, invalid: parsed.invalid };
        }
        calls.set(key, call);
      }
    } else if (eventType === "response.completed" || eventType === "response.done") {
      const result = isRecord(payload.response) ? payload.response : payload;
      finishReason = mapResponsesStopReason(result.status, result.incomplete_details);
      usage = isRecord(result.usage) ? mapResponsesUsage(result.usage) : usage;
    } else if (eventType === "error") {
      yield { type: "error", error: readString(payload.message) ?? payload };
      finishReason = "error";
    }
  }
  yield { type: "finish", reason: finishReason, usage };
}

function* responsesPayloadEvents(payload: Record<string, any>): Generator<ModelStreamEvent, void, void> {
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
          yield { type: "text-delta", text: part.text };
        }
      }
    } else if (item.type === "function_call") {
      const parsed = parseToolArguments(readString(item.arguments) ?? "{}");
      yield { type: "tool-call", id: readString(item.call_id) ?? readString(item.id) ?? randomToolCallId(), name: readString(item.name) ?? "unknown", arguments: parsed.args, invalid: parsed.invalid };
    } else if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      for (const part of summary) {
        if (isRecord(part) && typeof part.text === "string") yield { type: "reasoning-delta", id: "reasoning-0", text: part.text };
      }
    }
  }
  yield { type: "finish", reason: mapResponsesStopReason(readString(payload.status), payload.incomplete_details), usage: isRecord(payload.usage) ? mapResponsesUsage(payload.usage) : undefined };
}

function openAiMessages(
  context: ModelStreamContext,
  supportsDeveloperRole: boolean,
  reasoningProtocol: NativeModelConfig["reasoningProtocol"]
): unknown[] {
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: supportsDeveloperRole ? "developer" : "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: openAiUserContent(message.content) });
    } else if (message.role === "assistant") {
      const calls = message.content.filter((part): part is AgentToolCallContent => part.type === "toolCall");
      const reasoning = reasoningContent(message.content);
      messages.push({
        role: "assistant",
        content: textContent(message.content),
        ...(reasoning && reasoningProtocol !== "openai" && reasoningProtocol !== "anthropic"
          ? { reasoning_content: reasoning }
          : {}),
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {})
      });
    } else {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: resultText(message.content) });
    }
  }
  return messages;
}

function anthropicMessages(context: ModelStreamContext): unknown[] {
  const messages: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: anthropicUserContent(message.content) });
    } else if (message.role === "assistant") {
      messages.push({ role: "assistant", content: message.content.flatMap((part): unknown[] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "reasoning") {
          const signature = anthropicReasoningSignature(part.providerMetadata);
          return signature ? [{ type: "thinking", thinking: part.text, signature }] : [];
        }
        return [{ type: "tool_use", id: part.id, name: part.name, input: part.arguments }];
      }) });
    } else {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: resultText(message.content), is_error: message.isError === true }] });
    }
  }
  return messages;
}

function openAiTool(tool: AgentTool): unknown {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function anthropicTool(tool: AgentTool): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

function responsesTool(tool: AgentTool): unknown {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

function responsesInput(context: ModelStreamContext): unknown[] {
  const input: unknown[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: responsesUserContent(message.content) });
    } else if (message.role === "assistant") {
      const text = textContent(message.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.content.filter((part): part is AgentToolCallContent => part.type === "toolCall")) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
    } else {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: resultText(message.content) });
    }
  }
  return input;
}

function responsesUserContent(content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>): unknown {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((part) => part.type === "text"
    ? { type: "input_text", text: part.text ?? "" }
    : { type: "input_image", image_url: `data:${part.mimeType ?? "application/octet-stream"};base64,${part.data ?? ""}` });
}

function openAiUserContent(content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>): unknown {
  if (typeof content === "string") return content;
  if (content.length > 0 && content.every((part) => part.type === "text")) return content.map((part) => part.text ?? "").join("");
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text ?? "" }
    : { type: "image_url", image_url: { url: `data:${part.mimeType ?? "application/octet-stream"};base64,${part.data ?? ""}` } });
}

function anthropicUserContent(content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text ?? "" }
    : { type: "image", source: { type: "base64", media_type: part.mimeType ?? "application/octet-stream", data: part.data ?? "" } });
}

function anthropicReasoningMetadata(signature: string | undefined): Record<string, unknown> | undefined {
  return signature ? { anthropic: { signature } } : undefined;
}

function anthropicReasoningSignature(providerMetadata: Record<string, unknown> | undefined): string | undefined {
  const anthropic = isRecord(providerMetadata?.anthropic) ? providerMetadata.anthropic : undefined;
  return readString(anthropic?.signature);
}

function textContent(content: AgentAssistantMessage["content"]): string | null {
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return text || null;
}

function reasoningContent(content: AgentAssistantMessage["content"]): string | null {
  const text = content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
  return text || null;
}

function resultText(content: AgentToolResultContentLike[]): string {
  return content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("\n");
}

type AgentToolResultContentLike = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function applyOpenAiReasoning(body: Record<string, unknown>, config: NativeModelConfig, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const openai = isRecord(configured?.openai) ? configured.openai : undefined;
  const deepseek = isRecord(configured?.deepseek) ? configured.deepseek : undefined;
  const effort = readString(openai?.reasoningEffort);
  if (effort && effort !== "none") body.reasoning_effort = effort;
  const deepseekEffort = readString(deepseek?.reasoningEffort);
  if (deepseekEffort) body.reasoning_effort = deepseekEffort;
  if (isRecord(deepseek?.thinking)) body.thinking = deepseek.thinking;
  if (config.reasoningProtocol === "deepseek" && options.reasoning === "off") body.thinking = { type: "disabled" };
  applyAlibabaThinking(body, configured);
  if (config.reasoningProtocol === "moonshotai" && isKimiK3Model(config.modelId)) {
    const moonshot = isRecord(configured?.moonshotai) ? configured.moonshotai : undefined;
    const configuredEffort = readString(moonshot?.reasoningEffort);
    const fallbackEffort = options.reasoning && options.reasoning !== "off" ? options.reasoning : undefined;
    const effort = normalizeKimiReasoningEffort(configuredEffort ?? fallbackEffort);
    if (effort) body.reasoning_effort = effort;
    return;
  }
  applyMoonshotThinking(body, configured);
}

function normalizeKimiReasoningEffort(value: string | undefined): "low" | "high" | "max" | undefined {
  if (value === "low" || value === "minimal" || value === "medium") return "low";
  if (value === "high") return "high";
  if (value === "max" || value === "xhigh") return "max";
  return undefined;
}

function applyAnthropicThinking(body: Record<string, unknown>, config: NativeModelConfig, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const anthropic = isRecord(configured?.anthropic) ? configured.anthropic : undefined;
  if (isRecord(anthropic?.thinking) && anthropic.thinking.type === "enabled") {
    const budgetTokens = readNumber(anthropic.thinking.budgetTokens) ?? readNumber(anthropic.thinking.budget_tokens);
    body.thinking = {
      type: "enabled",
      ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens })
    };
    const maxTokens = readNumber(body.max_tokens);
    if (budgetTokens !== undefined && maxTokens !== undefined && maxTokens <= budgetTokens) {
      body.max_tokens = budgetTokens + 1_024;
    }
  }
}

function applyAlibabaThinking(body: Record<string, unknown>, configured: Record<string, unknown> | undefined): void {
  const alibaba = isRecord(configured?.alibaba) ? configured.alibaba : undefined;
  if (!alibaba) return;
  const enabled = typeof alibaba.enableThinking === "boolean"
    ? alibaba.enableThinking
    : typeof alibaba.enable_thinking === "boolean"
      ? alibaba.enable_thinking
      : undefined;
  if (enabled !== undefined) body.enable_thinking = enabled;
  const budget = readNumber(alibaba.thinkingBudget) ?? readNumber(alibaba.thinking_budget);
  if (budget !== undefined) body.thinking_budget = budget;
}

function applyMoonshotThinking(body: Record<string, unknown>, configured: Record<string, unknown> | undefined): void {
  const moonshot = isRecord(configured?.moonshotai) ? configured.moonshotai : undefined;
  const thinking = isRecord(moonshot?.thinking) ? moonshot.thinking : undefined;
  if (!thinking) return;
  const type = readString(thinking.type);
  const budgetTokens = readNumber(thinking.budgetTokens) ?? readNumber(thinking.budget_tokens);
  body.thinking = {
    ...(type ? { type } : {}),
    ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens })
  };
}

function applyResponsesReasoning(body: Record<string, unknown>, config: NativeModelConfig, options: ModelStreamOptions): void {
  const configured = isRecord(options.providerOptions) ? options.providerOptions : config.providerOptions;
  const openai = isRecord(configured?.openai) ? configured.openai : undefined;
  const effort = readString(openai?.reasoningEffort);
  if (effort && effort !== "none") body.reasoning = { effort };
  if (config.reasoningProtocol === "openai" && options.reasoning && options.reasoning !== "off" && !effort) {
    body.reasoning = { effort: options.reasoning === "xhigh" ? "high" : options.reasoning };
  }
}

function requestHeaders(config: NativeModelConfig, protocol: "openai" | "responses" | "anthropic"): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...config.headers };
  if (config.apiKey) {
    if (protocol === "anthropic" && config.anthropicAuthMode !== "bearer") headers["x-api-key"] = config.apiKey;
    else headers.authorization = `Bearer ${config.apiKey}`;
  }
  if (protocol === "anthropic") {
    headers["anthropic-version"] ??= "2023-06-01";
    if (config.provider === "claude-subscription") {
      headers["anthropic-beta"] ??= CLAUDE_SUBSCRIPTION_BETA;
      headers["anthropic-dangerous-direct-browser-access"] ??= "true";
      headers["x-app"] ??= "cli";
      headers["User-Agent"] ??= "claude-cli/2.1.153 (external, cli)";
    }
  }
  return headers;
}

function resolveEndpoint(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (normalized.endsWith(`/${suffix}`)) return normalized;
  if (suffix.startsWith("v1/") && normalized.endsWith("/v1")) return `${normalized}/${suffix.slice(3)}`;
  return `${normalized}/${suffix}`;
}

function requestSignal(options: ModelStreamOptions): AbortSignal | undefined {
  if (options.timeoutMs === undefined || options.timeoutMs <= 0) return options.signal;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

async function providerHttpError(response: Response, provider: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`${provider} request failed (${String(response.status)}): ${body.slice(0, 2_000)}`);
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }
      if (chunk.done) {
        const event = parseSseBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { event?: string; data: string } | undefined {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

function parseJson(value: string, label: string): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`${label} contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseToolArguments(value: string): { args: Record<string, unknown>; invalid: boolean } {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isRecord(parsed) ? { args: parsed, invalid: false } : { args: {}, invalid: true };
  } catch {
    return { args: {}, invalid: true };
  }
}

function parseToolArgumentsValue(value: unknown): { args: Record<string, unknown>; invalid: boolean } {
  if (isRecord(value)) return { args: value, invalid: false };
  return parseToolArguments(readString(value) ?? "{}");
}

function mapOpenAiStopReason(reason: string | undefined): AgentModelFinishReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  return reason ? "other" : "stop";
}

function mapAnthropicStopReason(reason: string | undefined): AgentModelFinishReason {
  if (reason === "tool_use") return "tool-calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return reason ? "other" : "stop";
}

function mapResponsesStopReason(status: unknown, incompleteDetails: unknown): AgentModelFinishReason {
  if (status === "completed") return "stop";
  if (status === "incomplete") {
    const reason = isRecord(incompleteDetails) ? readString(incompleteDetails.reason) : undefined;
    return reason === "max_output_tokens" ? "length" : "other";
  }
  return status ? "other" : "stop";
}

type AgentModelFinishReason = "stop" | "tool-calls" | "length" | "error" | "aborted" | "other";

function mapOpenAiUsage(value: Record<string, any>): AgentUsage {
  return {
    inputTokens: readNumber(value.prompt_tokens),
    outputTokens: readNumber(value.completion_tokens),
    totalTokens: readNumber(value.total_tokens),
    reasoningTokens: isRecord(value.completion_tokens_details) ? readNumber(value.completion_tokens_details.reasoning_tokens) : undefined
  };
}

function mapResponsesUsage(value: Record<string, any>): AgentUsage {
  const inputTokens = readNumber(value.input_tokens);
  const outputTokens = readNumber(value.output_tokens);
  const totalTokens = readNumber(value.total_tokens) ?? sumUsage({ inputTokens }, outputTokens);
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  return { inputTokens, outputTokens, totalTokens, reasoningTokens: readNumber(outputDetails.reasoning_tokens) };
}

function sumUsage(usage: AgentUsage | undefined, outputTokens: number | undefined): number | undefined {
  if (usage?.inputTokens === undefined || outputTokens === undefined) return undefined;
  return usage.inputTokens + outputTokens;
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function firstRecord(value: unknown): { value: Record<string, any> } | undefined {
  if (!Array.isArray(value)) return undefined;
  const item = value[0];
  return isRecord(item) ? { value: item } : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("");
  return text || undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomToolCallId(): string {
  return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
