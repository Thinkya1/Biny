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
      throw new Error(providerPayloadError(payload, "OpenAI Responses provider"));
    }
  }
  yield { type: "finish", reason: finishReason, usage };
}

function* responsesPayloadEvents(payload: Record<string, any>): Generator<ModelStreamEvent, void, void> {
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
        if (isRecord(part) && typeof part.text === "string") yield { type: "reasoning-delta", id: "reasoning-0", text: part.text };
      }
    }
  }
  yield { type: "finish", reason: mapResponsesStopReason(readString(payload.status), payload.incomplete_details), usage: isRecord(payload.usage) ? mapResponsesUsage(payload.usage) : undefined };
}
