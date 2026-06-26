/**
 * Agent 主循环模块。
 *
 * 这里实现最小 ReAct 事件流：用户输入进入模型，模型可以返回 tool call，loop 执行工具并把
 * tool result 追加回 messages，再继续请求模型直到得到最终回答。CLI 和 TUI 都只消费
 * `AgentLoopEvent`，不直接写 LLM 或 tool 执行逻辑。
 */
import { PermissionManager } from "../permission/PermissionManager.js";
import { formatProjectContext } from "../project/ProjectContext.js";
import { buildSystemPrompt } from "./prompts.js";
import type { AgentLoopEvent, AgentRuntimeContext } from "./types.js";
import type { ChatMessage, LLMResponse } from "../llm/provider.js";
import { appendAssistantMessage, appendAssistantToolCallMessage, createInitialMessages } from "./session.js";
import { normalizeToolCalls } from "./toolCalls.js";
import { runToolCallBatch } from "./toolRunner.js";

const maxToolRounds = 8;

export async function* runAgentLoop(input: string, context: AgentRuntimeContext): AsyncGenerator<AgentLoopEvent> {
  const messages = createInitialMessages(
    buildSystemPrompt("qa"),
    `${formatProjectContext(context.projectContext)}\n\nQuestion:\n${input}`,
    context.conversation
  );
  let finalContent = "";
  const permissionManager = context.permissionManager ?? new PermissionManager(context.config.permission);

  context.recorder.record({ type: "user_message", content: input });

  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      throwIfAborted(context.abortSignal);
      yield { type: "status", status: "thinking" };

      const response = await requestModel(messages, context, (delta) => {
        finalContent += delta;
      });

      if (response.content && !response.toolCalls?.length) {
        if (!context.llm.streamChat || context.llm.createResponse) {
          yield { type: "assistant_delta", content: response.content };
        }
        messages.splice(0, messages.length, ...appendAssistantMessage(messages, response.content));
        persistConversation(context, messages);
        context.recorder.record({ type: "assistant_message", content: response.content });
        yield { type: "assistant_message", content: response.content };
        yield { type: "status", status: "completed" };
        yield { type: "done", content: response.content };
        return;
      }

      const toolCalls = normalizeToolCalls(response.toolCalls ?? [], round);
      if (toolCalls.length) {
        messages.splice(0, messages.length, ...appendAssistantToolCallMessage(messages, response.content, toolCalls));
      } else if (response.content) {
        messages.splice(0, messages.length, ...appendAssistantMessage(messages, response.content));
      }

      yield* runToolCallBatch(toolCalls, messages, context, permissionManager);
    }

    throw new Error(`Agent loop exceeded ${String(maxToolRounds)} tool rounds.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.recorder.record({ type: "error", message });
    yield { type: "status", status: "error" };
    yield { type: "error", message };
    yield { type: "done", content: finalContent };
  }
}

export async function runAgentTask(input: string, context: AgentRuntimeContext): Promise<string> {
  let output = "";
  for await (const event of runAgentLoop(input, context)) {
    if (event.type === "assistant_delta") context.eventSink?.({ type: "assistant.delta", content: event.content });
    if (event.type === "assistant_message") {
      output = event.content;
      context.eventSink?.({ type: "assistant.completed", content: event.content });
    }
    if (event.type === "tool_call") context.eventSink?.({ type: "tool.call.started", toolCallId: event.call.id, tool: event.call.name, args: event.call.args, description: event.description, display: event.display });
    if (event.type === "tool_progress") context.eventSink?.({ type: "tool.call.progress", toolCallId: event.toolCallId, tool: event.tool, update: event.update });
    if (event.type === "tool_result") context.eventSink?.({ type: "tool.call.completed", toolCallId: event.toolCallId, tool: event.tool, result: event.result });
    if (event.type === "permission_request") context.eventSink?.({
      type: "permission.requested",
      tool: event.request.tool,
      title: event.request.title,
      details: event.request.details,
      requireFullYes: event.request.requireFullYes,
      diff: event.request.diff,
      actionType: event.request.actionType,
      riskLevel: event.request.riskLevel,
      targetPath: event.request.targetPath,
      command: event.request.command,
      reason: event.request.reason,
      changeSummary: event.request.changeSummary
    });
    if (event.type === "permission_result") context.eventSink?.(event.result.approved
      ? { type: "permission.approved", tool: event.request.tool, scope: event.result.scope ?? "once" }
      : { type: "permission.rejected", tool: event.request.tool, reason: event.result.message ?? "Denied by user." });
    if (event.type === "error") context.eventSink?.({ type: "session.error", sessionId: context.recorder.sessionId, message: event.message });
  }
  return output;
}

async function requestModel(messages: ChatMessage[], context: AgentRuntimeContext, onDelta: (delta: string) => void): Promise<LLMResponse> {
  if (context.llm.createResponse) {
    return await context.llm.createResponse({
      messages,
      tools: context.toolRegistry.listDefinitions(),
      signal: context.abortSignal
    });
  }

  if (context.llm.streamChat) {
    const content = await context.llm.streamChat(messages, onDelta, { signal: context.abortSignal });
    return { content };
  }

  return { content: await context.llm.chat(messages) };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Current turn interrupted.");
}

function persistConversation(context: AgentRuntimeContext, messages: ChatMessage[]): void {
  if (!context.conversation) return;
  context.conversation.splice(0, context.conversation.length, ...messages.filter((message) => message.role !== "system"));
}
