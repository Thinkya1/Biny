/**
 * Session 回放：事件流 → 模型对话历史。
 *
 * 新 session 同时记录可直接重放的 canonical AgentMessage 和用于界面/审计的扁平投影；旧 session
 * 只有扁平事件。这里优先读取 canonical 消息，并为旧格式重组 assistant/tool-call/tool-result，
 * 同时根据工具生命周期补齐被中断的工具调用、抽出消息树、最近上下文状态和用量。
 *
 * 恢复出来的历史会直接发回模型，所以宁可丢弃可疑内容（如缺签名的思考块），也不能拼出
 * 服务端会拒绝的消息序列。
 */
import path from "node:path";
import type { AgentMessage, AgentReasoningContent } from "../agent/core/types.js";
import { createToolOperationId, type ToolExecutionState } from "../tools/types.js";
import { readSessionEvents, readStoredSessionEvents } from "./events.js";
import type { ReasoningBlock, SessionContextState, SessionContextUsage, SessionEvent, SessionUsage } from "./recorder.js";

export interface SessionReplay {
  events: SessionEvent[];
  /** 会话超过大小上限、只回放了最近部分时为 true。 */
  truncated?: boolean;
  messages: AgentMessage[];
  contextUsage?: SessionContextUsage;
  contextState?: SessionContextState;
  usage: SessionUsage[];
  recoveredToolResults: Array<Extract<SessionEvent, { type: "tool_result" }>>;
  discardedToolCalls: SessionDiscardedToolCall[];
  messageTree: SessionMessageNode[];
}

export interface SessionReplayOptions {
  sessionId?: string;
}

export interface SessionDiscardedToolCall {
  tool: string;
  toolCallId?: string;
  sequence?: number;
  operationId: string;
  state: "not_started";
  reason: "not_started";
}

export interface SessionMessageNode {
  id: string;
  parentId?: string;
  eventIndex: number;
  message: AgentMessage;
}

export async function replaySession(filePath: string): Promise<SessionReplay> {
  return replaySessionEvents(await readSessionEvents(filePath), { sessionId: sessionIdFromPath(filePath) });
}

export async function replayStoredSession(workspaceRoot: string, session: string | undefined): Promise<SessionReplay> {
  const stored = await readStoredSessionEvents(workspaceRoot, session);
  return { ...replaySessionEvents(stored.events), truncated: stored.truncated };
}

export function replaySessionEvents(recordedEvents: SessionEvent[], options: SessionReplayOptions = {}): SessionReplay {
  const recovery = interruptedToolResults(recordedEvents, options);
  const recoveredToolResults = recovery.results;
  const events = orderRecoveredToolResults(recordedEvents, recoveredToolResults);
  return {
    events,
    messages: sessionEventsToConversation(events, {
      discardedToolCallIds: new Set(recovery.discarded.map((call) => call.toolCallId).filter((id): id is string => id !== undefined)),
      recoveredToolResults
    }),
    contextUsage: latestContextUsage(events),
    contextState: latestContextState(events),
    usage: sessionUsage(events),
    recoveredToolResults,
    discardedToolCalls: recovery.discarded,
    messageTree: sessionMessageTree(events)
  };
}

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

/**
 * recovery result 物理上是在发现中断时追加到 JSONL 尾部的，但模型协议要求它紧跟原调用。
 * 这里只调整回放顺序，不改写事实文件；这样即使恢复结果已经持久化且后来又追加了新用户消息，
 * 重放仍能得到合法的 assistant tool-call → tool-result → user 顺序。
 */
function orderRecoveredToolResults(recordedEvents: SessionEvent[], newResults: ToolResultEvent[]): SessionEvent[] {
  const recoveryEvents: ToolResultEvent[] = [];
  const seen = new Set<ToolResultEvent>();
  for (const event of recordedEvents) {
    if (event.type !== "tool_result" || !event.recovered || seen.has(event)) continue;
    seen.add(event);
    recoveryEvents.push(event);
  }
  for (const event of newResults) {
    if (seen.has(event)) continue;
    seen.add(event);
    recoveryEvents.push(event);
  }
  if (!recoveryEvents.length) return recordedEvents;

  const base = recordedEvents.filter((event) => event.type !== "tool_result" || !event.recovered);
  const insertBefore = new Map<number, ToolResultEvent[]>();
  for (const result of recoveryEvents) {
    const callIndex = findRecoveryCallIndex(base, result);
    const boundary = findRecoveryBoundary(base, callIndex);
    const pending = insertBefore.get(boundary) ?? [];
    pending.push(result);
    insertBefore.set(boundary, pending);
  }

  const ordered: SessionEvent[] = [];
  for (let index = 0; index <= base.length; index += 1) {
    for (const result of insertBefore.get(index) ?? []) ordered.push(result);
    const event = base[index];
    if (event) ordered.push(event);
  }
  return ordered;
}

function findRecoveryCallIndex(events: SessionEvent[], result: ToolResultEvent): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "tool_call") {
      if (result.toolCallId !== undefined && event.toolCallId === result.toolCallId) return index;
      if (result.toolCallId === undefined && event.tool === result.tool && (result.sequence === undefined || event.sequence === result.sequence)) return index;
    }
    if (event?.type === "agent_message" && event.message.role === "assistant" && result.toolCallId !== undefined
      && event.message.content.some((part) => part.type === "toolCall" && part.id === result.toolCallId)) return index;
  }
  return events.length - 1;
}

function findRecoveryBoundary(events: SessionEvent[], callIndex: number): number {
  const start = Math.max(0, callIndex + 1);
  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    if ((event?.type === "user_message" || event?.type === "assistant_message") && !event.auditOnly) return index;
    if (event?.type === "agent_message" && event.message.role === "assistant") return index;
  }
  return events.length;
}

/** 新格式直接保留 canonical 消息的父子关系；旧事件没有 ID 时仍按原重放路径兼容。 */
export function sessionMessageTree(events: SessionEvent[]): SessionMessageNode[] {
  return events.flatMap((event, eventIndex): SessionMessageNode[] => {
    if (event.type === "user_message" && !event.auditOnly) {
      if (!event.messageId) return [];
      return [{
        id: event.messageId,
        parentId: event.parentMessageId,
        eventIndex,
        message: { role: "user", content: event.content }
      }];
    }
    if (event.type === "agent_message") {
      if (!event.messageId) return [];
      return [{ id: event.messageId, parentId: event.parentMessageId, eventIndex, message: event.message }];
    }
    return [];
  });
}

/**
 * 补齐没有结果的工具调用。
 *
 * 进程被 Ctrl+C 或崩溃打断时，session 里会留下只有 tool_call 没有 tool_result 的记录，
 * 而模型协议要求每个 tool-call 必须有对应结果，缺一个整段历史就会被拒。这里根据审计账本
 * 补一条成功、取消、失败或 unknown 的结果；旧 session 没有生命周期证据时一律保守处理为 unknown。
 */
interface RecoveryLedgerEntry {
  tool: string;
  toolCallId?: string;
  sequence?: number;
  operationId: string;
  state?: ToolExecutionState;
  evidence?: string;
  lifecycleSeen: boolean;
  hasResult: boolean;
  active: boolean;
  auditOnly?: boolean;
  discarded?: boolean;
}

interface RecoveryLedger {
  results: Array<Extract<SessionEvent, { type: "tool_result" }>>;
  discarded: SessionDiscardedToolCall[];
}

function interruptedToolResults(events: SessionEvent[], options: SessionReplayOptions): RecoveryLedger {
  const entries = new Map<string, RecoveryLedgerEntry>();
  const activeKeys = new Set<string>();
  const callKey = (toolCallId: string | undefined, sequence: number | undefined, index: number): string =>
    toolCallId ?? `session-tool-${String(sequence ?? index + 1)}`;
  const ensureEntry = (
    tool: string,
    toolCallId: string | undefined,
    sequence: number | undefined,
    index: number,
    auditOnly?: boolean
  ): RecoveryLedgerEntry => {
    const key = callKey(toolCallId, sequence, index);
    const current = entries.get(key);
    if (current) {
      current.sequence ??= sequence;
      current.auditOnly ??= auditOnly;
      activeKeys.add(key);
      return current;
    }
    const entry: RecoveryLedgerEntry = {
      tool,
      toolCallId,
      sequence,
      operationId: createToolOperationId(options.sessionId ?? "legacy", key),
      lifecycleSeen: false,
      hasResult: false,
      active: true,
      auditOnly
    };
    entries.set(key, entry);
    activeKeys.add(key);
    return entry;
  };
  const findEntry = (toolCallId: string | undefined, tool: string, sequence: number | undefined): [string, RecoveryLedgerEntry] | undefined => {
    if (toolCallId) {
      const direct = entries.get(toolCallId);
      if (direct) return [toolCallId, direct];
    }
    for (const key of activeKeys) {
      const entry = entries.get(key);
      if (entry && entry.tool === tool && (sequence === undefined || entry.sequence === sequence)) return [key, entry];
    }
    for (const [key, entry] of entries) {
      if (!entry.hasResult && entry.tool === tool) return [key, entry];
    }
    return undefined;
  };
  for (const [index, event] of events.entries()) {
    if (event.type === "user_message" && !event.auditOnly) {
      continue;
    }
    if (event.type === "assistant_message" && !event.auditOnly) {
      continue;
    }
    if (event.type === "agent_message") {
      if (event.message.role === "assistant") {
        for (const part of event.message.content) {
          if (part.type !== "toolCall") continue;
          ensureEntry(part.name, part.id, undefined, index);
        }
      } else {
        const found = findEntry(event.message.toolCallId, event.message.toolName, undefined);
        if (found) {
          found[1].hasResult = true;
          activeKeys.delete(found[0]);
        }
      }
      continue;
    }
    if (event.type === "tool_call") {
      ensureEntry(event.tool, event.toolCallId, event.sequence, index, event.auditOnly);
      continue;
    }
    if (event.type === "tool_execution") {
      const found = findEntry(event.toolCallId, event.tool, event.sequence)
        ?? [event.toolCallId ?? callKey(event.toolCallId, event.sequence, index), ensureEntry(event.tool, event.toolCallId, event.sequence, index)];
      found[1].operationId = event.operationId;
      found[1].state = event.state;
      found[1].evidence = event.evidence;
      found[1].lifecycleSeen = true;
      found[1].active = true;
      activeKeys.add(found[0]);
      continue;
    }
    if (event.type === "tool_result") {
      const found = findEntry(event.toolCallId, event.tool, event.sequence);
      if (found) {
        found[1].hasResult = true;
        if (event.executionStatus === "cancelled" && resultStatus(event.result) === "skipped") {
          found[1].state = "not_started";
          found[1].lifecycleSeen = true;
          found[1].discarded = true;
        }
        activeKeys.delete(found[0]);
      }
    }
  }

  const results: Array<Extract<SessionEvent, { type: "tool_result" }>> = [];
  const discarded: SessionDiscardedToolCall[] = [];
  for (const call of entries.values()) {
    if (!call.discarded) continue;
    discarded.push({
      tool: call.tool,
      toolCallId: call.toolCallId,
      sequence: call.sequence,
      operationId: call.operationId,
      state: "not_started",
      reason: "not_started"
    });
  }
  for (const key of activeKeys) {
    const call = entries.get(key);
    if (!call || call.hasResult) continue;
    const state = call.lifecycleSeen ? call.state ?? "unknown" : "unknown";
    const operationId = call.operationId;
    if (state === "not_started") {
      discarded.push({
        tool: call.tool,
        toolCallId: call.toolCallId,
        sequence: call.sequence,
        operationId,
        state,
        reason: "not_started"
      });
      results.push({
        type: "tool_result",
        tool: call.tool,
        toolCallId: call.toolCallId,
        sequence: call.sequence,
        operationId,
        executionStatus: "cancelled",
        recovered: true,
        auditOnly: true,
        evidence: call.evidence,
        result: { status: "skipped", interrupted: true, recovered: true, executionStatus: "cancelled", operationId, evidence: call.evidence }
      });
      continue;
    }
    const executionStatus = state === "side_effect_committed" || state === "succeeded"
      ? "succeeded"
      : state === "cancelled"
        ? "cancelled"
        : state === "failed"
          ? "failed"
          : "unknown";
    const result = executionStatus === "succeeded"
      ? { status: "recovered-success", recovered: true, executionStatus, operationId, evidence: call.evidence }
      : executionStatus === "cancelled"
        ? { status: "cancelled", interrupted: true, recovered: true, executionStatus, operationId, evidence: call.evidence }
        : executionStatus === "failed"
          ? { error: "Tool call failed before its result was persisted.", interrupted: true, recovered: true, executionStatus, operationId, evidence: call.evidence }
          : { error: "Tool call was interrupted; completion status is unknown.", interrupted: true, recovered: true, executionStatus: "unknown" as const, operationId };
    results.push({
      type: "tool_result",
      tool: call.tool,
      toolCallId: call.toolCallId,
      sequence: call.sequence,
      operationId,
      executionStatus,
      recovered: true,
      evidence: call.evidence,
      result
    });
  }
  return { results, discarded };
}

function resultStatus(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
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
export function sessionEventsToConversation(
  events: SessionEvent[],
  options: {
    discardedToolCallIds?: ReadonlySet<string>;
    recoveredToolResults?: ReadonlyArray<Extract<SessionEvent, { type: "tool_result" }>>;
  } = {}
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const pendingCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const openCalls = new Map<string, { id: string; name: string; args: unknown }>();
  let pendingAssistantContent = "";
  let pendingReasoningContent: string | undefined;
  let pendingReasoningProviderOptions: Record<string, unknown> | undefined;
  let pendingReasoningBlocks: ReasoningBlock[] | undefined;
  let callsFlushed = false;
  let canonicalTurn = false;
  const recoveredResults = new Set(options.recoveredToolResults ?? []);
  const consumedRecoveredResults = new Set<Extract<SessionEvent, { type: "tool_result" }>>();

  const flushPendingCalls = (): void => {
    if (!pendingCalls.length || callsFlushed) return;
    messages.push({
      role: "assistant",
      content: [
        ...replayReasoningParts(pendingReasoningBlocks, pendingReasoningContent, pendingReasoningProviderOptions),
        ...(pendingAssistantContent ? [{ type: "text" as const, text: pendingAssistantContent }] : []),
        ...pendingCalls.map((call) => ({
          type: "toolCall" as const,
          id: call.id,
          name: call.name,
          arguments: normalizeToolArguments(call.args)
        }))
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

  const appendToolResult = (
    event: Extract<SessionEvent, { type: "tool_result" }>,
    toolCallId: string
  ): void => {
    messages.push({
      role: "toolResult",
      toolCallId,
      toolName: event.tool,
      content: [{ type: "text", text: stringifyResult(event.result) }],
      details: event.result
    });
    openCalls.delete(toolCallId);
  };

  const appendRecoveredResultsForOpenCalls = (): void => {
    for (const event of recoveredResults) {
      if (consumedRecoveredResults.has(event)) continue;
      const toolCallId = event.toolCallId && openCalls.has(event.toolCallId)
        ? event.toolCallId
        : findToolCallId(openCalls, event.tool);
      if (!toolCallId) continue;
      consumedRecoveredResults.add(event);
      if (event.auditOnly || options.discardedToolCallIds?.has(toolCallId)) {
        openCalls.delete(toolCallId);
        continue;
      }
      flushPendingCalls();
      appendToolResult(event, toolCallId);
    }
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
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      messages.push({ role: "user", content: event.content });
      canonicalTurn = false;
      continue;
    }

    if (event.type === "agent_message") {
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      if (event.message.role === "assistant" && options.discardedToolCallIds?.size) {
        const content = event.message.content.filter((part) => part.type !== "toolCall" || !options.discardedToolCallIds?.has(part.id));
        if (content.length) messages.push({ ...event.message, content });
      } else {
        messages.push(event.message);
      }
      if (event.message.role === "assistant") {
        for (const part of event.message.content) {
          if (part.type === "toolCall" && !options.discardedToolCallIds?.has(part.id)) {
            openCalls.set(part.id, { id: part.id, name: part.name, args: part.arguments });
          }
        }
      } else {
        openCalls.delete(event.message.toolCallId);
      }
      canonicalTurn = true;
      continue;
    }

    if (event.type === "assistant_message") {
      if (canonicalTurn) continue;
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
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
      if (event.toolCallId && options.discardedToolCallIds?.has(event.toolCallId)) continue;
      // 上一批调用已经 flush 且全部收到结果，说明这是新一批调用，重新开始累积。
      if (canonicalTurn) {
        const id = event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`;
        if (!openCalls.has(id)) openCalls.set(id, { id, name: event.tool, args: event.args });
        continue;
      }
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
      if (event.toolCallId && options.discardedToolCallIds?.has(event.toolCallId)) continue;
      if (event.recovered && recoveredResults.has(event) && consumedRecoveredResults.has(event)) continue;
      // 完整 canonical session 已经有 agent_message/toolResult；这里只接收 replay 新补的结果。
      if (canonicalTurn && !event.recovered) continue;
      const toolCallId = event.toolCallId ?? findToolCallId(openCalls, event.tool) ?? `session-tool-${String(event.sequence ?? index + 1)}`;
      flushPendingCalls();
      appendToolResult(event, toolCallId);
      continue;
    }

    flushPendingCalls();
  }

  flushPendingCalls();
  appendRecoveredResultsForOpenCalls();
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
): AgentReasoningContent[] {
  if (blocks?.length) {
    return blocks
      .filter((block) => block.text && block.providerOptions)
      .map((block) => ({
        type: "reasoning" as const,
        text: block.text,
        providerMetadata: block.providerOptions
      }));
  }
  if (!content || !providerOptions) return [];
  return [{ type: "reasoning", text: content, providerMetadata: providerOptions }];
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
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

function sessionIdFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : undefined;
}
