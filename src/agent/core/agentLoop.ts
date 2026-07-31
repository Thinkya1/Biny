/**
 * Biny 自有的 Pi 风格 Agent Loop。
 *
 * Provider 只负责输出归一化的 ModelStreamEvent；工具由 Loop 显式校验和执行，
 * 不再把多步控制权交给模型 SDK。这样权限、预算、审计和 Completion Gate 都有
 * 明确的介入点。
 */
import { AsyncEventQueue } from "../../runtime/AsyncEventQueue.js";
import { validateJsonSchema } from "../../tools/schema.js";
import type {
  AgentAssistantMessage,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnContext,
  AgentMessage,
  AgentToolCallContent,
  AgentToolResult,
  AgentToolResultMessage
} from "./types.js";

export async function* agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
    tools: [...config.tools]
  };
  const newMessages = [...prompts];
  yield { type: "agent_start" };
  for (const prompt of prompts) {
    yield { type: "message_start", message: prompt };
    yield { type: "message_end", message: prompt };
  }
  for await (const event of runLoop(currentContext, newMessages, config, signal)) yield event;
  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

export async function* agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent, AgentMessage[], void> {
  if (!context.messages.length) throw new Error("Cannot continue an empty agent context.");
  const last = context.messages.at(-1);
  if (last?.role === "assistant") throw new Error("Cannot continue from an assistant message.");
  const currentContext: AgentContext = { ...context, messages: [...context.messages], tools: [...config.tools] };
  const newMessages: AgentMessage[] = [];
  yield { type: "agent_start" };
  for await (const event of runLoop(currentContext, newMessages, config, signal)) yield event;
  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined
): AsyncGenerator<AgentEvent, void, void> {
  let steps = 0;
  let pendingMessages = await config.getSteeringMessages?.() ?? [];

  while (true) {
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      signal?.throwIfAborted();
      if (steps >= config.maxSteps) {
        yield { type: "error", error: `Agent reached its ${String(config.maxSteps)}-step limit.`, fatal: false };
        return;
      }
      yield { type: "turn_start" };

      for (const message of pendingMessages) {
        context.messages.push(message);
        newMessages.push(message);
        yield { type: "message_start", message };
        yield { type: "message_end", message };
      }
      pendingMessages = [];

      const assistantEvents: AgentEvent[] = [];
      const assistant = await streamAssistant(context, config, signal, (event) => {
        assistantEvents.push(event);
        return Promise.resolve(event);
      });
      yield* assistantEvents;
      context.messages.push(assistant);
      newMessages.push(assistant);
      steps += 1;

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        yield { type: "turn_end", message: assistant, toolResults: [], messages: [...context.messages] };
        return;
      }

      const calls = assistant.content.filter((part): part is AgentToolCallContent => part.type === "toolCall");
      let toolResults: AgentToolResultMessage[] = [];
      hasMoreToolCalls = calls.length > 0;
      if (calls.length > 0) {
        const truncated = assistant.stopReason === "length";
        const toolBatch = await executeToolCalls(context, assistant, calls, config, signal, truncated);
        toolResults = toolBatch.messages;
        yield* toolBatch.events;
        for (const result of toolResults) {
          context.messages.push(result);
          newMessages.push(result);
        }
        hasMoreToolCalls = !toolBatch.terminate;
      }

      yield { type: "turn_end", message: assistant, toolResults, messages: [...context.messages] };
      const turnContext: AgentLoopTurnContext = { message: assistant, toolResults, context, newMessages };
      if (await config.shouldStopAfterTurn?.(turnContext)) return;
      pendingMessages = await config.getSteeringMessages?.() ?? [];
    }

    const followUpMessages = await config.getFollowUpMessages?.() ?? [];
    if (!followUpMessages.length) return;
    pendingMessages = followUpMessages;
  }
}

async function streamAssistant(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: (event: AgentEvent) => Promise<AgentEvent>
): Promise<AgentAssistantMessage> {
  let text = "";
  const reasoning = new Map<string, { text: string; providerMetadata?: Record<string, unknown> }>();
  const toolCalls: AgentToolCallContent[] = [];
  let stopReason: AgentAssistantMessage["stopReason"] = "stop";
  let usage: AgentAssistantMessage["usage"];
  const assistant: AgentAssistantMessage = { role: "assistant", content: [] };
  await emit({ type: "message_start", message: assistant });
  try {
    const messages = config.transformContext
      ? await config.transformContext(context.messages, signal)
      : context.messages;
    const stream = await config.model.stream({ ...context, messages, tools: context.tools }, { ...config.modelOptions, signal });
    for await (const event of stream) {
      signal?.throwIfAborted();
      if (event.type === "text-delta") {
        text += event.text;
      } else if (event.type === "reasoning-start") {
        reasoning.set(event.id, { text: "", providerMetadata: event.providerMetadata });
      } else if (event.type === "reasoning-delta") {
        const block = reasoning.get(event.id) ?? { text: "" };
        block.text += event.text;
        block.providerMetadata = event.providerMetadata ?? block.providerMetadata;
        reasoning.set(event.id, block);
      } else if (event.type === "tool-call") {
        toolCalls.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.arguments, invalid: event.invalid });
      } else if (event.type === "finish") {
        stopReason = event.reason;
        usage = event.usage;
      } else if (event.type === "error") {
        stopReason = "error";
        assistant.errorMessage = errorMessage(event.error);
        await emit({ type: "error", error: assistant.errorMessage, fatal: true });
      }
      if (event.type !== "start" && event.type !== "finish") {
        await emit({ type: "message_update", message: snapshotAssistant(text, reasoning, toolCalls, assistant), event });
      }
    }
  } catch (error) {
    stopReason = signal?.aborted ? "aborted" : "error";
    assistant.errorMessage = errorMessage(error);
    await emit({ type: "error", error: assistant.errorMessage, fatal: !signal?.aborted });
  }

  const duplicateToolCallIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  for (const call of toolCalls) {
    if (seenToolCallIds.has(call.id)) duplicateToolCallIds.add(call.id);
    seenToolCallIds.add(call.id);
  }
  if (duplicateToolCallIds.size > 0) {
    const message = `Duplicate tool call id received from the model: ${[...duplicateToolCallIds].join(", ")}. The turn was stopped before tool execution.`;
    assistant.stopReason = "error";
    assistant.errorMessage = message;
    await emit({ type: "error", error: message, fatal: true });
    await emit({ type: "message_end", message: assistant });
    return assistant;
  }

  if (text) assistant.content.push({ type: "text", text });
  for (const block of reasoning.values()) {
    if (block.text) assistant.content.push({ type: "reasoning", text: block.text, providerMetadata: block.providerMetadata });
  }
  assistant.content.push(...toolCalls);
  assistant.stopReason = stopReason;
  assistant.usage = usage;
  await emit({ type: "message_end", message: assistant });
  return assistant;
}

function snapshotAssistant(
  text: string,
  reasoning: Map<string, { text: string; providerMetadata?: Record<string, unknown> }>,
  toolCalls: AgentToolCallContent[],
  assistant: AgentAssistantMessage
): AgentAssistantMessage {
  const content: AgentAssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text });
  for (const block of reasoning.values()) {
    if (block.text) content.push({ type: "reasoning", text: block.text, providerMetadata: block.providerMetadata });
  }
  content.push(...toolCalls);
  return { ...assistant, content };
}

async function executeToolCalls(
  context: AgentContext,
  assistant: AgentAssistantMessage,
  calls: AgentToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  truncated: boolean
): Promise<{ messages: AgentToolResultMessage[]; events: AgentEvent[]; terminate: boolean }> {
  const sequential = config.toolExecution === "sequential"
    || calls.some((call) => context.tools.find((tool) => tool.name === call.name)?.executionMode === "sequential");
  if (sequential) {
    const results: Array<{ message: AgentToolResultMessage; events: AgentEvent[]; terminate: boolean }> = [];
    for (const call of calls) results.push(await executeOneTool(context, assistant, call, config, signal, truncated));
    return {
      messages: results.map((result) => result.message),
      events: results.flatMap((result) => result.events),
      terminate: results.length > 0 && results.every((result) => result.terminate)
    };
  }
  const results = await Promise.all(calls.map(async (call) => await executeOneTool(context, assistant, call, config, signal, truncated)));
  return {
    messages: results.map((result) => result.message),
    events: results.flatMap((result) => result.events),
    terminate: results.length > 0 && results.every((result) => result.terminate)
  };
}

async function executeOneTool(
  context: AgentContext,
  assistant: AgentAssistantMessage,
  call: AgentToolCallContent,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  truncated: boolean
): Promise<{ message: AgentToolResultMessage; events: AgentEvent[]; terminate: boolean }> {
  const events: AgentEvent[] = [{ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }];
  const tool = context.tools.find((candidate) => candidate.name === call.name);
  let result: AgentToolResult;
  let syntheticFailure = false;
  if (!tool) {
    result = errorResult(`Tool ${call.name} not found.`);
    syntheticFailure = true;
  } else if (truncated) {
    result = errorResult(`Tool call "${call.name}" was not executed because the model output was truncated.`);
    syntheticFailure = true;
  } else if (call.invalid) {
    result = errorResult(`Invalid tool arguments for ${call.name}: the provider returned malformed JSON.`);
    syntheticFailure = true;
  } else {
    const validation = validateJsonSchema(tool.parameters, call.arguments);
    if (!validation.ok) {
      result = errorResult(`Invalid tool arguments for ${call.name}: ${validation.errors.join("; ")}`);
      syntheticFailure = true;
    } else {
      const before = await config.beforeToolCall?.({ assistantMessage: assistant, toolCall: call, args: call.arguments, context }, signal);
      if (before?.block) {
        result = errorResult(before.reason ?? `Tool ${call.name} was blocked.`);
      } else {
        try {
          result = await tool.execute(call.id, call.arguments, signal, (update) => {
            events.push({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, update });
          });
        } catch (error) {
          result = errorResult(errorMessage(error));
        }
        const after = await config.afterToolCall?.({ assistantMessage: assistant, toolCall: call, args: call.arguments, result, context }, signal);
        if (after) result = { ...result, ...after };
      }
    }
  }
  events.push({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result });
  if (syntheticFailure) {
    const message = result.content.find((part) => part.type === "text")?.text ?? `Tool ${call.name} failed.`;
    events.push({ type: "error", error: message, fatal: false });
  }
  return {
    message: {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    isError: result.isError === true,
    timestamp: Date.now()
    },
    events,
    terminate: result.terminate === true
  };
}

function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 保留给后续 Provider/宿主直接使用的异步事件队列工厂。 */
export function createAgentEventQueue<T>(): AsyncEventQueue<T> {
  return new AsyncEventQueue<T>();
}
