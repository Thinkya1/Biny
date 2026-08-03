/**
 * OpenAI Responses 协议 Adapter。
 */
import type { AgentUsage, ModelStreamContext, ModelStreamEvent, ModelStreamOptions } from "../../agent/core/types.js";
import type { ApiAdapter, ApiAdapterRequest } from "../ApiAdapterRegistry.js";
import {
  applyResponsesReasoning,
  isRecord,
  mapResponsesStopReason,
  mapResponsesUsage,
  parseJson,
  parseToolArguments,
  providerHttpError,
  providerPayloadError,
  randomToolCallId,
  readSse,
  readString,
  removeUndefined,
  requestHeaders,
  requestSignal,
  resolveEndpoint,
  responsesInput,
  responsesTool,
  type AgentModelFinishReason
} from "./shared.js";

export const openAiResponsesAdapter: ApiAdapter = {
  id: "responses",
  stream: (request, context, options) => streamOpenAiResponses(request, request.fetch, context, options)
};

export async function* streamOpenAiResponses(
  config: ApiAdapterRequest,
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
    yield* responsesPayloadEvents(await response.json() as Record<string, unknown>);
    return;
  }

  const calls = new Map<string, ResponsesToolCall>();
  let finishReason: AgentModelFinishReason = "stop";
  let usage: AgentUsage | undefined;
  let receivedTerminalEvent = false;
  for await (const event of readSse(response.body)) {
    const payload = parseJson(event.data, "OpenAI Responses stream event");
    const eventType = readString(event.event) ?? readString(payload.type);
    if (eventType === "response.output_text.delta") {
      const text = readString(payload.delta);
      if (text) yield { type: "text-delta", text };
    } else if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") {
      const text = readString(payload.delta);
      if (text) yield {
        type: "reasoning-delta",
        id: "reasoning-0",
        text,
        providerMetadata: eventType === "response.reasoning_summary_text.delta"
          ? { openai: { summary: true } }
          : undefined
      };
    } else if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item?.type === "function_call") {
        const call = resolveResponsesToolCall(calls, readString(item.id), readString(item.call_id));
        call.name = readString(item.name) ?? call.name;
        call.arguments = readString(item.arguments) ?? call.arguments;
        if (eventType === "response.output_item.done") {
          const toolCall = responsesToolCallEvent(call);
          if (toolCall) yield toolCall;
        }
      }
    } else if (eventType === "response.function_call_arguments.delta") {
      const itemId = readString(payload.item_id);
      const callId = readString(payload.call_id);
      if (itemId || callId) {
        const call = resolveResponsesToolCall(calls, itemId, callId);
        call.arguments += readString(payload.delta) ?? "";
      }
    } else if (eventType === "response.function_call_arguments.done") {
      const itemId = readString(payload.item_id);
      const callId = readString(payload.call_id);
      if (itemId || callId) {
        const call = resolveResponsesToolCall(calls, itemId, callId);
        call.arguments = readString(payload.arguments) ?? call.arguments;
        call.name = readString(payload.name) ?? call.name;
        // 标准事件只在 output_item.added 里携带函数名和 call_id；若 added 丢失，
        // 等 output_item.done 补齐身份后再发，不能先用 item_id 生成错误的工具结果引用。
        const toolCall = call.name ? responsesToolCallEvent(call) : undefined;
        if (toolCall) yield toolCall;
      }
    } else if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
      const result = isRecord(payload.response) ? payload.response : payload;
      finishReason = mapResponsesStopReason(result.status, result.incomplete_details);
      usage = isRecord(result.usage) ? mapResponsesUsage(result.usage) : usage;
      receivedTerminalEvent = true;
    } else if (eventType === "response.failed") {
      const result = isRecord(payload.response) ? payload.response : payload;
      throw new Error(providerPayloadError(result, "OpenAI Responses provider"));
    } else if (eventType === "error") {
      throw new Error(providerPayloadError(payload, "OpenAI Responses provider"));
    }
  }
  if (!receivedTerminalEvent) {
    throw new Error("OpenAI Responses stream ended before a terminal response event.");
  }
  yield { type: "finish", reason: finishReason, usage };
}

interface ResponsesToolCall {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

/** 同一调用在不同 Responses 事件里分别使用 item_id 与 call_id，需要映射到同一状态。 */
function resolveResponsesToolCall(
  calls: Map<string, ResponsesToolCall>,
  itemId: string | undefined,
  callId: string | undefined
): ResponsesToolCall {
  const call = (callId ? calls.get(callId) : undefined)
    ?? (itemId ? calls.get(itemId) : undefined)
    ?? { id: callId ?? itemId ?? randomToolCallId(), name: "", arguments: "", emitted: false };
  if (callId) {
    call.id = callId;
    calls.set(callId, call);
  }
  if (itemId) calls.set(itemId, call);
  return call;
}

function responsesToolCallEvent(call: ResponsesToolCall): ModelStreamEvent | undefined {
  if (call.emitted) return undefined;
  const parsed = parseToolArguments(call.arguments);
  call.emitted = true;
  return { type: "tool-call", id: call.id, name: call.name || "unknown", arguments: parsed.args, invalid: parsed.invalid };
}

function* responsesPayloadEvents(payload: Record<string, unknown>): Generator<ModelStreamEvent, void, void> {
  if (payload.error !== undefined) {
    yield { type: "error", error: providerPayloadError(payload, "OpenAI Responses provider") };
    return;
  }
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
        if (isRecord(part) && typeof part.text === "string") yield {
          type: "reasoning-delta",
          id: "reasoning-0",
          text: part.text,
          providerMetadata: { openai: { summary: true } }
        };
      }
    }
  }
  yield { type: "finish", reason: mapResponsesStopReason(readString(payload.status), payload.incomplete_details), usage: isRecord(payload.usage) ? mapResponsesUsage(payload.usage) : undefined };
}
