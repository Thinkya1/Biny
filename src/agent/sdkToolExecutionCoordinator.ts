/**
 * Native Vercel AI SDK tool bridge.
 *
 * The SDK owns tool-call parsing, parallel execution and the model loop. This
 * coordinator only wraps each SDK tool with Biny's permission, scheduling,
 * progress and JSONL session policies.
 */
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { ZodError } from "zod";
import { confirmPermissionRequest } from "../permission/confirm.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { createToolPermissionRequest } from "../tools/display/ToolDisplay.js";
import { ToolAccesses } from "../tools/access.js";
import { validateJsonSchema } from "../tools/schema.js";
import { ToolScheduler } from "../tools/scheduler.js";
import type { Tool, ToolInputDisplay, RunnableToolExecution } from "../tools/types.js";
import type { AgentPermissionRequest, AgentRuntimeContext, AgentSessionEvent } from "./types.js";

interface ToolExecutionOutcome {
  result: unknown;
  errorMessage?: string;
}

interface PreparedToolCall {
  ok: true;
  args: unknown;
  execution: RunnableToolExecution;
}

interface FailedPreparedToolCall {
  ok: false;
  result: unknown;
  errorMessage: string;
}

export interface AgentStepContext {
  assistantContent?: string;
  reasoningContent?: string;
}

export class SdkToolExecutionCoordinator {
  private readonly scheduler = new ToolScheduler<ToolExecutionOutcome>();
  private permissionTail: Promise<void> = Promise.resolve();
  private fallbackSequence = 0;

  constructor(
    private readonly context: AgentRuntimeContext,
    private readonly permissionManager: PermissionManager,
    private readonly emit: (event: Exclude<AgentSessionEvent, { type: "sdk" | "status" | "done" }>) => void,
    private readonly getStepContext: () => AgentStepContext = () => ({})
  ) {}

  createTools(): ToolSet {
    const tools: Record<string, unknown> = {};
    for (const registered of this.context.toolRegistry.list()) {
      tools[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.schema,
        execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => await this.execute(registered, input, options)
      });
    }
    return tools as ToolSet;
  }

  async handleInvalidToolCall(toolName: string, toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    let registered: Tool;
    try {
      registered = this.context.toolRegistry.get(toolName);
    } catch {
      const result = { error: `Unknown tool: ${toolName}` };
      const sequence = this.nextSequence();
      this.emit({ type: "tool-started", toolCallId, tool: toolName, args: input });
      this.context.recorder.record({
        type: "tool_call",
        tool: toolName,
        args: input,
        toolCallId,
        sequence,
        assistantContent: this.getStepContext().assistantContent,
        reasoningContent: this.getStepContext().reasoningContent
      });
      this.context.recorder.record({ type: "tool_result", tool: toolName, result, toolCallId, sequence });
      this.emit({ type: "error", message: result.error, recorded: true });
      return result;
    }
    return await this.execute(registered, input, { toolCallId, abortSignal: signal } as ToolExecutionOptions<unknown>);
  }

  private async execute(toolDefinition: Tool, input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown> {
    const call = { id: options.toolCallId, name: toolDefinition.name, args: input };
    const sequence = this.nextSequence();
    const stepContext = this.getStepContext();
    this.context.recorder.record({
      type: "tool_call",
      tool: call.name,
      args: call.args,
      toolCallId: call.id,
      sequence,
      assistantContent: stepContext.assistantContent,
      reasoningContent: stepContext.reasoningContent
    });

    const prepared = await this.prepareToolCall(toolDefinition, call);
    if (!prepared.ok) {
      this.emit({ type: "tool-started", toolCallId: call.id, tool: call.name, args: call.args });
      return await this.finishSyntheticCall(call, sequence, prepared.result, prepared.errorMessage);
    }

    this.emit({
      type: "tool-started",
      toolCallId: call.id,
      tool: call.name,
      args: call.args,
      description: prepared.execution.description,
      display: prepared.execution.display
    });

    const permissionRequest = await this.buildPermissionRequest(call, prepared.args, prepared.execution);
    const evaluation = this.permissionManager.evaluate(permissionRequest);
    if (evaluation.decision === "deny") {
      this.permissionManager.applyResult(permissionRequest, { approved: false, message: evaluation.reason });
      return await this.finishSyntheticCall(call, sequence, deniedToolResult(permissionRequest, evaluation.reason));
    }

    if (evaluation.decision === "ask") {
      const permissionResult = await this.withPermissionGate(async () => {
        const gatedEvaluation = this.permissionManager.evaluate(permissionRequest);
        if (gatedEvaluation.decision === "deny") {
          const result = { approved: false as const, message: gatedEvaluation.reason };
          this.permissionManager.applyResult(permissionRequest, result);
          return result;
        }
        if (gatedEvaluation.decision === "allow") return { approved: true as const, scope: "once" as const };
        this.emit({ type: "permission-requested", request: permissionRequest });
        const result = this.context.confirmPermission
          ? await this.context.confirmPermission(permissionRequest)
          : await confirmPermissionRequest(permissionRequest);
        this.permissionManager.applyResult(permissionRequest, result);
        this.emit({ type: "permission-result", request: permissionRequest, result });
        return result;
      });
      if (!permissionResult.approved) {
        return await this.finishSyntheticCall(call, sequence, deniedToolResult(permissionRequest, permissionResult.message ?? "Denied by user."));
      }
    } else {
      this.permissionManager.applyResult(permissionRequest, { approved: true, scope: "once" });
    }

    const outcome = await this.scheduler.schedule({
      accesses: prepared.execution.accesses ?? ToolAccesses.all(),
      start: async () => await this.executeResolvedTool(call, prepared.execution, options.abortSignal)
    });
    const result = attachPermissionPreview(outcome.result, permissionRequest);
    this.context.recorder.record({ type: "tool_result", tool: call.name, result, toolCallId: call.id, sequence });
    this.context.contextMemory?.observeToolResult(call.name, call.args, result);
    if (outcome.errorMessage) {
      this.context.recorder.record({ type: "error", message: outcome.errorMessage });
      this.emit({ type: "error", message: outcome.errorMessage, recorded: true });
    }
    return result;
  }

  private async finishSyntheticCall(call: { id: string; name: string; args: unknown }, sequence: number, result: unknown, errorMessage?: string): Promise<unknown> {
    this.context.recorder.record({ type: "tool_result", tool: call.name, result, toolCallId: call.id, sequence });
    this.context.contextMemory?.observeToolResult(call.name, call.args, result);
    if (errorMessage) {
      this.context.recorder.record({ type: "error", message: errorMessage });
      this.emit({ type: "error", message: errorMessage, recorded: true });
    }
    return result;
  }

  private async prepareToolCall(toolDefinition: Tool, call: { name: string; args: unknown }): Promise<PreparedToolCall | FailedPreparedToolCall> {
    try {
      const schemaValidation = validateJsonSchema(toolDefinition.parameters, call.args);
      if (!schemaValidation.ok) {
        const message = `Invalid tool arguments for ${call.name}: ${schemaValidation.errors.join("; ")}`;
        return { ok: false, result: { error: message, validation: true }, errorMessage: message };
      }
      const args = toolDefinition.schema.parse(call.args);
      const execution = await toolDefinition.resolveExecution(args);
      if (isToolExecutionError(execution)) return { ok: false, result: execution.result, errorMessage: execution.errorMessage };
      return { ok: true, args, execution };
    } catch (error) {
      const message = formatToolError(call.name, error);
      return {
        ok: false,
        result: error instanceof ZodError ? { error: message, validation: true } : { error: message },
        errorMessage: message
      };
    }
  }

  private async executeResolvedTool(call: { id: string; name: string }, execution: RunnableToolExecution, signal?: AbortSignal): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    try {
      const result = await execution.execute({
        toolCallId: call.id,
        signal,
        onUpdate: (update) => this.emit({ type: "tool-progress", toolCallId: call.id, tool: call.name, update })
      });
      return { result: attachToolSummary(result, Date.now() - startedAt) };
    } catch (error) {
      const message = formatToolError(call.name, error);
      return { result: { error: message, durationMs: Date.now() - startedAt }, errorMessage: message };
    }
  }

  private async buildPermissionRequest(call: { id: string; name: string; args: unknown }, args: unknown, execution: RunnableToolExecution): Promise<AgentPermissionRequest> {
    const permissionContext = analyzePermissionRequest({
      toolName: call.name,
      args,
      sessionId: this.context.recorder.sessionId,
      projectRoot: this.context.workspaceRoot
    });
    const request = await createToolPermissionRequest({ id: call.id, name: call.name, args }, {
      workspaceRoot: this.context.workspaceRoot,
      ignore: this.context.config.workspace.ignore,
      sessionId: this.context.recorder.sessionId
    }, permissionContext);
    return {
      ...request,
      reason: execution.description ?? request.reason,
      changeSummary: request.changeSummary ?? displaySummary(execution.display)
    };
  }

  private nextSequence(): number {
    return this.context.recorder.nextToolCallSequence?.() ?? ++this.fallbackSequence;
  }

  private async withPermissionGate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.permissionTail;
    let release!: () => void;
    this.permissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function isToolExecutionError(execution: unknown): execution is { isError: true; result: unknown; errorMessage: string } {
  return typeof execution === "object" && execution !== null && "isError" in execution && execution.isError === true && "errorMessage" in execution && typeof execution.errorMessage === "string";
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof ZodError) return `Invalid tool arguments for ${toolName}: ${error.issues.map((issue) => issue.message).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

function deniedToolResult(request: AgentPermissionRequest, reason: string): unknown {
  return { status: "denied", approved: false, tool: request.tool, actionType: request.actionType, riskLevel: request.riskLevel, targetPath: request.targetPath, command: request.command, reason };
}

function displaySummary(display: ToolInputDisplay | undefined): string | undefined {
  if (!display) return undefined;
  if (display.kind === "command") return `Run command: ${display.command}`;
  if (display.kind === "file_io") return `${display.operation}${display.path ? ` ${display.path}` : ""}`.trim();
  return display.summary;
}

function attachPermissionPreview(result: unknown, request: AgentPermissionRequest): unknown {
  if (!request.diff && !request.preview && !request.changeSummary) return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { result, diffPreview: request.diff, contentPreview: request.preview, changeSummary: request.changeSummary };
  return { ...(result as Record<string, unknown>), diffPreview: request.diff, contentPreview: request.preview, changeSummary: request.changeSummary };
}

function attachToolSummary(result: unknown, durationMs: number): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { result, durationMs };
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return { ...record, durationMs, outputLines: output ? output.split(/\r?\n/).length : undefined, truncated: false };
}
