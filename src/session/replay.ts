/**
 * Session 回放：事件流 → 模型对话历史。
 *
 * session 里记的是扁平事件（user_message / assistant_message / tool_call / tool_result），
 * 而模型需要的是「assistant 消息里带 tool-call 分片、紧跟 tool 角色消息」的嵌套结构，
 * 这里负责把前者重新组装成后者，同时补齐被中断的工具调用、抽出最近的上下文状态和用量。
 *
 * 恢复出来的历史会直接发回模型，所以宁可丢弃可疑内容（如缺签名的思考块），也不能拼出
 * 服务端会拒绝的消息序列。
 */
import type { ModelMessage } from "ai";
import { readSessionEvents, readStoredSessionEvents } from "./events.js";
import type { ReasoningBlock, SessionContextState, SessionContextUsage, SessionEvent, SessionUsage } from "./recorder.js";

type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"];
type AssistantPart = Exclude<AssistantContent, string>[number];
type ReplayReasoningPart = Extract<AssistantPart, { type: "reasoning" }>;

export interface SessionReplay {
  events: SessionEvent[];
  /** 会话超过大小上限、只回放了最近部分时为 true。 */
  truncated?: boolean;
  messages: ModelMessage[];
  contextUsage?: SessionContextUsage;
  contextState?: SessionContextState;
  usage: SessionUsage[];
  recoveredToolResults: Array<Extract<SessionEvent, { type: "tool_result" }>>;
}

export async function replaySession(filePath: string): Promise<SessionReplay> {
  return replaySessionEvents(await readSessionEvents(filePath));
}

export async function replayStoredSession(workspaceRoot: string, session: string | undefined): Promise<SessionReplay> {
  const stored = await readStoredSessionEvents(workspaceRoot, session);
  return { ...replaySessionEvents(stored.events), truncated: stored.truncated };
}

export function replaySessionEvents(recordedEvents: SessionEvent[]): SessionReplay {
  const recoveredToolResults = interruptedToolResults(recordedEvents);
  const events = [...recordedEvents, ...recoveredToolResults];
  return {
    events,
    messages: sessionEventsToConversation(events),
    contextUsage: latestContextUsage(events),
    contextState: latestContextState(events),
    usage: sessionUsage(events),
    recoveredToolResults
  };
}

/**
 * 补齐没有结果的工具调用。
 *
 * 进程被 Ctrl+C 或崩溃打断时，session 里会留下只有 tool_call 没有 tool_result 的记录，
 * 而模型协议要求每个 tool-call 必须有对应结果，缺一个整段历史就会被拒。这里为这些悬空
 * 调用补一条「被中断」的结果。
 */
function interruptedToolResults(events: SessionEvent[]): Array<Extract<SessionEvent, { type: "tool_result" }>> {
  const openCalls: Array<Extract<SessionEvent, { type: "tool_call" }>> = [];
  for (const event of events) {
    // 出现新的对话消息说明上一轮已经收尾，之前还挂着的调用不必再追（它们属于更早的轮次，
    // 且那一轮已经能正常继续），只关心最后一轮遗留下来的。
    if (event.type === "user_message" || event.type === "assistant_message") {
      openCalls.splice(0, openCalls.length);
      continue;
    }
    if (event.type === "tool_call") {
      openCalls.push(event);
      continue;
    }
    if (event.type !== "tool_result") continue;
    // 旧 session 可能没记 toolCallId，只能退回按工具名匹配最早那个未闭合调用。
    const index = event.toolCallId
      ? openCalls.findIndex((call) => call.toolCallId === event.toolCallId)
      : openCalls.findIndex((call) => call.tool === event.tool);
    if (index !== -1) openCalls.splice(index, 1);
  }
  return openCalls.map((call) => ({
    type: "tool_result",
    tool: call.tool,
    toolCallId: call.toolCallId,
    sequence: call.sequence,
    auditOnly: call.auditOnly,
    result: { error: "Tool call was interrupted before completion.", interrupted: true }
  }));
}

/**
 * 取最近一次的上下文预算。从后往前找，`contextUsage` 是 `contextState` 之前的旧字段，
 * 放在最后兜底以兼容历史 session。
 */
function latestContextUsage(events: SessionEvent[]): SessionContextUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant_message" && event.contextState !== undefined) return event.contextState.budget;
    if (event?.type === "user_message" && event.contextState !== undefined) return event.contextState.budget;
    if (event?.type === "user_message" && event.contextUsage !== undefined) return event.contextUsage;
  }
  return undefined;
}

function latestContextState(events: SessionEvent[]): SessionContextState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if ((event?.type === "assistant_message" || event?.type === "user_message") && event.contextState !== undefined) return event.contextState;
  }
  return undefined;
}

/**
 * 汇总所有用量记录。一次对话的开销可能挂在三处：assistant 消息本身、user 消息上的准备
 * 阶段（如上下文压缩、记忆检索），以及事件附带的 `relatedUsage`（如子 agent）。
 */
function sessionUsage(events: SessionEvent[]): SessionUsage[] {
  return events.flatMap((event) => {
    const usage = event.type === "assistant_message" && event.usage !== undefined ? [event.usage] : [];
    const preparationUsage = event.type === "user_message" && event.preparationUsage !== undefined ? event.preparationUsage : [];
    const relatedUsage = "relatedUsage" in event && event.relatedUsage !== undefined ? event.relatedUsage : [];
    return [...usage, ...preparationUsage, ...relatedUsage];
  });
}

/**
 * 事件流重组为对话消息。
 *
 * 核心难点是「一条 assistant 消息可能对应多个 tool_call」：事件是逐个记录的，而消息要把
 * 同一批调用合并进一条 assistant 消息。因此这里维护一组 pending 状态，遇到 tool_result 或
 * 新的对话消息时才 flush 出去；`callsFlushed` 防止同一批调用被写入两次。
 */
export function sessionEventsToConversation(events: SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const pendingCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const openCalls = new Map<string, { id: string; name: string; args: unknown }>();
  let pendingAssistantContent = "";
  let pendingReasoningContent: string | undefined;
  let pendingReasoningProviderOptions: Record<string, unknown> | undefined;
  let pendingReasoningBlocks: ReasoningBlock[] | undefined;
  let callsFlushed = false;

  const flushPendingCalls = (): void => {
    if (!pendingCalls.length || callsFlushed) return;
    messages.push({
      role: "assistant",
      content: [
        ...replayReasoningParts(pendingReasoningBlocks, pendingReasoningContent, pendingReasoningProviderOptions),
        ...(pendingAssistantContent ? [{ type: "text" as const, text: pendingAssistantContent }] : []),
        ...pendingCalls.map((call) => ({ type: "tool-call" as const, toolCallId: call.id, toolName: call.name, input: call.args }))
      ]
    });
    callsFlushed = true;
  };

  const resetPendingCalls = (): void => {
    pendingCalls.splice(0, pendingCalls.length);
    openCalls.clear();
    pendingAssistantContent = "";
    pendingReasoningContent = undefined;
    pendingReasoningProviderOptions = undefined;
    pendingReasoningBlocks = undefined;
    callsFlushed = false;
  };

  for (const [index, event] of events.entries()) {
    // auditOnly 事件只为审计留痕（例如被拒绝的调用），不能回放给模型。
    if (
      (event.type === "user_message"
        || event.type === "assistant_message"
        || event.type === "tool_call"
        || event.type === "tool_result")
      && event.auditOnly
    ) continue;
    if (event.type === "user_message") {
      flushPendingCalls();
      resetPendingCalls();
      messages.push({ role: "user", content: event.content });
      continue;
    }

    if (event.type === "assistant_message") {
      flushPendingCalls();
      resetPendingCalls();
      if (!event.content && !event.reasoningContent) continue;
      messages.push({
        role: "assistant",
        content: [
          ...replayReasoningParts(event.reasoningBlocks, event.reasoningContent, event.reasoningProviderOptions),
          ...(event.content ? [{ type: "text" as const, text: event.content }] : [])
        ]
      });
      continue;
    }

    if (event.type === "tool_call") {
      // 上一批调用已经 flush 且全部收到结果，说明这是新一批调用，重新开始累积。
      if (callsFlushed && openCalls.size === 0) resetPendingCalls();
      const toolCall = {
        // 旧 session 没记 id，用序号造一个稳定 id，保证 call 与 result 能配上。
        id: event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`,
        name: event.tool,
        args: event.args
      };
      pendingAssistantContent = event.assistantContent ?? pendingAssistantContent;
      pendingReasoningContent = event.reasoningContent ?? pendingReasoningContent;
      pendingReasoningProviderOptions = event.reasoningProviderOptions ?? pendingReasoningProviderOptions;
      pendingReasoningBlocks = event.reasoningBlocks ?? pendingReasoningBlocks;
      pendingCalls.push(toolCall);
      openCalls.set(toolCall.id, toolCall);
      callsFlushed = false;
      continue;
    }

    if (event.type === "tool_result") {
      const toolCallId = event.toolCallId ?? findToolCallId(openCalls, event.tool) ?? `session-tool-${String(event.sequence ?? index + 1)}`;
      flushPendingCalls();
      messages.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId, toolName: event.tool, output: { type: "text", value: stringifyResult(event.result) } }]
      });
      openCalls.delete(toolCallId);
      continue;
    }

    flushPendingCalls();
  }

  flushPendingCalls();
  return messages;
}

/**
 * 还原思考块。
 *
 * Anthropic 这类服务商的 reasoning 块必须带着它自己的签名元数据才能回放，而且签名是按块
 * 独立生成的，所以要逐块输出，缺签名的直接丢掉——拼出服务端会拒绝的历史比少一段思考更糟。
 *
 * `content` / `providerOptions` 是「按块记录」之前的单块旧格式，为兼容已有 session 保留。
 */
function replayReasoningParts(
  blocks: ReasoningBlock[] | undefined,
  content: string | undefined,
  providerOptions: Record<string, unknown> | undefined
): ReplayReasoningPart[] {
  if (blocks?.length) {
    return blocks
      .filter((block) => block.text && block.providerOptions)
      .map((block) => ({
        type: "reasoning" as const,
        text: block.text,
        providerOptions: block.providerOptions as ReplayReasoningPart["providerOptions"]
      }));
  }
  if (!content || !providerOptions) return [];
  return [{ type: "reasoning", text: content, providerOptions: providerOptions as ReplayReasoningPart["providerOptions"] }];
}

function findToolCallId(calls: Map<string, { id: string; name: string; args: unknown }>, toolName: string): string | undefined {
  return [...calls.values()].find((call) => call.name === toolName)?.id;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
