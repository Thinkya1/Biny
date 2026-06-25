/**
 * Agent 主循环模块。
 *
 * 这里实现最小 ReAct 事件流：用户输入进入模型，模型可以返回 tool call，loop 执行工具并把
 * tool result 追加回 messages，再继续请求模型直到得到最终回答。CLI 和 TUI 都只消费
 * `AgentLoopEvent`，不直接写 LLM 或 tool 执行逻辑。
 */
import { ZodError } from "zod";
import { confirmPermissionRequest } from "../permission/confirm.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { formatProjectContext } from "../project/ProjectContext.js";
import { createToolPermissionRequest } from "../tools/display/ToolDisplay.js";
import { ToolAccesses } from "../tools/access.js";
import { validateJsonSchema } from "../tools/schema.js";
import { ToolScheduler } from "../tools/scheduler.js";
import { buildSystemPrompt } from "./prompts.js";
import type { AgentLoopEvent, AgentPermissionRequest, AgentPermissionResult, AgentRuntimeContext } from "./types.js";
import type { ChatMessage, LLMResponse, LLMToolCall } from "../llm/provider.js";
import { appendAssistantMessage, appendAssistantToolCallMessage, appendToolResultMessage, createInitialMessages } from "./session.js";
import type { RunnableToolExecution, Tool, ToolInputDisplay } from "../tools/types.js";

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

      const toolCalls = response.toolCalls ?? [];
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
      tools: context.toolRegistry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      signal: context.abortSignal
    });
  }

  if (context.llm.streamChat) {
    const content = await context.llm.streamChat(messages, onDelta, { signal: context.abortSignal });
    return { content };
  }

  return { content: await context.llm.chat(messages) };
}

interface ToolExecutionOutcome {
  call: LLMToolCall;
  result: unknown;
  errorMessage?: string;
}

interface PreparedToolCall {
  ok: true;
  tool: Tool<unknown, unknown>;
  args: unknown;
  execution: RunnableToolExecution;
}

interface FailedPreparedToolCall {
  ok: false;
  result: unknown;
  errorMessage: string;
}

type BatchToolCall =
  | { kind: "synthetic"; call: LLMToolCall; result: unknown; errorMessage?: string }
  | { kind: "runnable"; call: LLMToolCall; execution: RunnableToolExecution; permissionRequest: AgentPermissionRequest };

async function* runToolCallBatch(
  toolCalls: LLMToolCall[],
  messages: ChatMessage[],
  context: AgentRuntimeContext,
  permissionManager: PermissionManager
): AsyncGenerator<AgentLoopEvent> {
  const batch: BatchToolCall[] = [];

  for (const call of toolCalls) {
    throwIfAborted(context.abortSignal);
    context.recorder.record({ type: "tool_call", tool: call.name, args: call.args });
    const prepared = await prepareToolCall(call, context);
    if (!prepared.ok) {
      yield { type: "tool_call", call };
      batch.push({ kind: "synthetic", call, result: prepared.result, errorMessage: prepared.errorMessage });
      continue;
    }

    yield {
      type: "tool_call",
      call,
      description: prepared.execution.description,
      display: prepared.execution.display
    };

    const permissionRequest = await buildPermissionRequest(call, prepared.args, prepared.execution, context);
    const evaluation = permissionManager.evaluate(permissionRequest);
    if (evaluation.decision === "deny") {
      permissionManager.applyResult(permissionRequest, { approved: false, message: evaluation.reason });
      batch.push({ kind: "synthetic", call, result: deniedToolResult(permissionRequest, evaluation.reason) });
      continue;
    }

    const shouldAsk = evaluation.decision === "ask";
    if (shouldAsk) yield { type: "permission_request", request: permissionRequest };
    const permissionResult = shouldAsk ? await requestPermission(permissionRequest, context) : { approved: true, scope: "once" as const };
    permissionManager.applyResult(permissionRequest, permissionResult);
    if (shouldAsk) yield { type: "permission_result", request: permissionRequest, result: permissionResult };
    if (!permissionResult.approved) {
      const reason = permissionResult.message ?? "Denied by user.";
      batch.push({ kind: "synthetic", call, result: deniedToolResult(permissionRequest, reason) });
      continue;
    }

    batch.push({ kind: "runnable", call, execution: prepared.execution, permissionRequest });
  }

  if (batch.some((item) => item.kind === "runnable")) yield { type: "status", status: "running" };
  const queue = createAsyncQueue<AgentLoopEvent>();
  const scheduler = new ToolScheduler<ToolExecutionOutcome>();
  const resultPromises = batch.map((item) => {
    if (item.kind === "synthetic") {
      return Promise.resolve({ call: item.call, result: item.result, errorMessage: item.errorMessage });
    }
    return scheduler.schedule({
      accesses: item.execution.accesses ?? ToolAccesses.all(),
      start: async () => attachPermissionPreview(
        await executeResolvedToolCall(item.call, item.execution, context, queue.push),
        item.permissionRequest
      )
    });
  });
  const allResults = Promise.all(resultPromises).finally(() => queue.close());

  for await (const event of queue) yield event;

  const outcomes = await allResults;
  for (const outcome of outcomes) {
    context.recorder.record({ type: "tool_result", tool: outcome.call.name, result: outcome.result });
    messages.splice(0, messages.length, ...appendToolResultMessage(messages, outcome.call.id, outcome.call.name, outcome.result));
    yield { type: "tool_result", toolCallId: outcome.call.id, tool: outcome.call.name, result: outcome.result };
    if (outcome.errorMessage) {
      context.recorder.record({ type: "error", message: outcome.errorMessage });
      yield { type: "status", status: "error" };
      yield { type: "error", message: outcome.errorMessage };
    }
  }
}

function attachPermissionPreview(outcome: ToolExecutionOutcome, request: AgentPermissionRequest): ToolExecutionOutcome {
  if (!request.diff && !request.preview && !request.changeSummary) return outcome;
  if (typeof outcome.result !== "object" || outcome.result === null || Array.isArray(outcome.result)) {
    return {
      ...outcome,
      result: {
        result: outcome.result,
        diffPreview: request.diff,
        contentPreview: request.preview,
        changeSummary: request.changeSummary
      }
    };
  }
  return {
    ...outcome,
    result: {
      ...(outcome.result as Record<string, unknown>),
      diffPreview: request.diff,
      contentPreview: request.preview,
      changeSummary: request.changeSummary
    }
  };
}

async function prepareToolCall(call: LLMToolCall, context: AgentRuntimeContext): Promise<PreparedToolCall | FailedPreparedToolCall> {
  try {
    const tool = context.toolRegistry.get(call.name);
    const schemaValidation = validateJsonSchema(tool.parameters, call.args);
    if (!schemaValidation.ok) {
      const message = `Invalid tool arguments for ${call.name}: ${schemaValidation.errors.join("; ")}`;
      return { ok: false, result: { error: message, validation: true }, errorMessage: message };
    }
    const args = tool.schema.parse(call.args);
    const execution = await tool.resolveExecution(args);
    if (isToolExecutionError(execution)) {
      return { ok: false, result: execution.result, errorMessage: execution.errorMessage };
    }
    return { ok: true, tool, args, execution };
  } catch (error) {
    const message = formatToolError(call.name, error);
    const result = error instanceof ZodError ? { error: message, validation: true } : { error: message };
    return { ok: false, result, errorMessage: message };
  }
}

function isToolExecutionError(execution: unknown): execution is { isError: true; result: unknown; errorMessage: string } {
  return typeof execution === "object"
    && execution !== null
    && "isError" in execution
    && execution.isError === true
    && "errorMessage" in execution
    && typeof execution.errorMessage === "string";
}

async function executeResolvedToolCall(
  call: LLMToolCall,
  execution: RunnableToolExecution,
  context: AgentRuntimeContext,
  emitProgress: (event: AgentLoopEvent) => void
): Promise<ToolExecutionOutcome> {
  const startedAt = Date.now();
  try {
    const result = await execution.execute({
      toolCallId: call.id,
      signal: context.abortSignal,
      onUpdate: (update) => emitProgress({ type: "tool_progress", toolCallId: call.id, tool: call.name, update })
    });
    const wrappedResult = attachToolSummary(result, Date.now() - startedAt);
    return { call, result: wrappedResult };
  } catch (error) {
    const message = formatToolError(call.name, error);
    const result = { error: message, durationMs: Date.now() - startedAt };
    return { call, result, errorMessage: message };
  }
}

async function requestPermission(request: AgentPermissionRequest, context: AgentRuntimeContext): Promise<AgentPermissionResult> {
  return context.confirmPermission
    ? await context.confirmPermission(request)
    : await confirmPermissionRequest(request);
}

async function buildPermissionRequest(
  call: LLMToolCall,
  args: unknown,
  execution: RunnableToolExecution,
  context: AgentRuntimeContext
): Promise<AgentPermissionRequest> {
  const permissionContext = analyzePermissionRequest({
    toolName: call.name,
    args,
    sessionId: context.recorder.sessionId,
    projectRoot: context.workspaceRoot
  });
  const request = await createToolPermissionRequest({ ...call, args }, {
    workspaceRoot: context.workspaceRoot,
    ignore: context.config.workspace.ignore,
    sessionId: context.recorder.sessionId
  }, permissionContext);
  return {
    ...request,
    reason: execution.description ?? request.reason,
    changeSummary: request.changeSummary ?? displaySummary(execution.display)
  };
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof ZodError) {
    return `Invalid tool arguments for ${toolName}: ${error.issues.map((issue) => issue.message).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Current turn interrupted.");
}

function deniedToolResult(request: AgentPermissionRequest, reason: string): unknown {
  return {
    status: "denied",
    approved: false,
    tool: request.tool,
    actionType: request.actionType,
    riskLevel: request.riskLevel,
    targetPath: request.targetPath,
    command: request.command,
    reason
  };
}

interface AsyncEventQueue<T> extends AsyncIterable<T> {
  push: (value: T) => void;
  close: () => void;
}

function createAsyncQueue<T>(): AsyncEventQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push: (value: T) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    close: () => {
      closed = true;
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as T, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (closed) return Promise.resolve({ value: undefined as T, done: true });
          return awaitNext(waiters);
        }
      };
    }
  };
}

function awaitNext<T>(waiters: Array<(result: IteratorResult<T>) => void>): Promise<IteratorResult<T>> {
  return new Promise<IteratorResult<T>>((resolve) => {
    waiters.push(resolve);
  });
}

function displaySummary(display: ToolInputDisplay | undefined): string | undefined {
  if (!display) return undefined;
  if (display.kind === "command") return `Run command: ${display.command}`;
  if (display.kind === "file_io") {
    const target = display.path ? ` ${display.path}` : "";
    return `${display.operation}${target}`.trim();
  }
  return display.summary;
}

function attachToolSummary(result: unknown, durationMs: number): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { result, durationMs };
  }
  return {
    ...(result as Record<string, unknown>),
    durationMs,
    outputLines: countOutputLines(result),
    truncated: false
  };
}

function countOutputLines(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return output ? output.split(/\r?\n/).length : undefined;
}

function persistConversation(context: AgentRuntimeContext, messages: ChatMessage[]): void {
  if (!context.conversation) return;
  context.conversation.splice(0, context.conversation.length, ...messages.filter((message) => message.role !== "system"));
}
