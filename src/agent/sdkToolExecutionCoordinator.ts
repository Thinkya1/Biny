/**
 * Native Vercel AI SDK tool bridge.
 *
 * The SDK owns tool-call parsing, parallel execution and the model loop. This
 * coordinator only wraps each SDK tool with Biny's permission, scheduling,
 * progress and JSONL session policies.
 */
import { createHash } from "node:crypto";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { ZodError } from "zod";
import { confirmPermissionRequest } from "../permission/confirm.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { createToolPermissionRequest } from "../tools/display/ToolDisplay.js";
import { ToolAccesses } from "../tools/access.js";
import {
  maxEditFileBytes,
  readBoundedUtf8File,
  sameOptionalFileSnapshot,
  type FileSnapshot
} from "../tools/file/safeFileIo.js";
import { validateJsonSchema } from "../tools/schema.js";
import { ToolScheduler } from "../tools/scheduler.js";
import type {
  ApprovedFileSnapshot,
  Tool,
  ToolExecution,
  ToolInputDisplay,
  RunnableToolExecution,
  ToolRisk,
  ToolSource
} from "../tools/types.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../workspace/resolvePath.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentRuntimeContext, AgentSessionEvent } from "./types.js";

interface ToolExecutionOutcome {
  result: unknown;
  errorMessage?: string;
  permissionRequest?: AgentPermissionRequest;
}

interface FilePermissionBaseline {
  exists: boolean;
  content: string;
  snapshot: FileSnapshot | null;
}

interface PermissionSnapshot {
  request: AgentPermissionRequest;
  baseline?: FilePermissionBaseline;
  targetPath?: string;
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

const externalToolAbortDrainMs = 500;

export interface AgentStepContext {
  assistantContent?: string;
  reasoningContent?: string;
}

export class SdkToolExecutionCoordinator {
  private readonly admissionScheduler: ToolScheduler<unknown>;
  private readonly scheduler: ToolScheduler<ToolExecutionOutcome>;
  private readonly pendingExecutions = new Set<Promise<unknown>>();
  private readonly observedToolCallCounts = new Map<string, number>();
  private readonly duplicateToolCallIds = new Set<string>();
  private readonly duplicateExecutionCounts = new Map<string, number>();
  private permissionTail: Promise<void> = Promise.resolve();
  private fallbackSequence = 0;

  constructor(
    private readonly context: AgentRuntimeContext,
    private readonly permissionManager: PermissionManager,
    private readonly emit: (event: Exclude<AgentSessionEvent, { type: "sdk" | "status" | "done" }>) => void,
    private readonly getStepContext: () => AgentStepContext = () => ({}),
    private readonly allowedToolNames?: ReadonlySet<string>
  ) {
    this.admissionScheduler = new ToolScheduler({
      maxConcurrency: context.config.agent.maxConcurrentTools,
      maxQueuedTasks: context.config.agent.maxQueuedToolCalls
    });
    this.scheduler = new ToolScheduler({
      maxConcurrency: context.config.agent.maxConcurrentTools,
      // The admission scheduler already bounds the entire pipeline. At most
      // maxConcurrentTools admitted calls can reach this resource scheduler,
      // so this internal queue only needs room for those active pipelines.
      maxQueuedTasks: context.config.agent.maxConcurrentTools
    });
  }

  createTools(): ToolSet {
    const tools: Record<string, unknown> = {};
    for (const { tool: registered, source } of this.context.toolRegistry.listEntries()) {
      if (this.allowedToolNames && !this.allowedToolNames.has(registered.name)) continue;
      tools[registered.name] = tool({
        description: registered.description,
        inputSchema: registered.schema,
        execute: (input: unknown, options: ToolExecutionOptions<unknown>) => this.trackExecution(this.execute(registered, input, options, source))
      });
    }
    return tools as ToolSet;
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingExecutions.size > 0) {
      await Promise.allSettled([...this.pendingExecutions]);
    }
  }

  observeToolCall(toolCallId: string): string | undefined {
    const count = (this.observedToolCallCounts.get(toolCallId) ?? 0) + 1;
    this.observedToolCallCounts.set(toolCallId, count);
    if (count < 2) return undefined;
    this.duplicateToolCallIds.add(toolCallId);
    return `Duplicate tool call id received from the model: ${toolCallId}. The turn was stopped before tool execution.`;
  }

  async handleInvalidToolCall(toolName: string, toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.allowedToolNames && !this.allowedToolNames.has(toolName)) {
      const call = { id: toolCallId, name: toolName, args: input };
      const sequence = this.nextSequence();
      const errorMessage = `Tool ${toolName} is not available in the current mode.`;
      const stepContext = this.getStepContext();
      this.context.recorder.record({
        type: "tool_call",
        tool: toolName,
        args: input,
        toolCallId,
        sequence,
        assistantContent: stepContext.assistantContent,
        reasoningContent: stepContext.reasoningContent
      });
      this.emit({ type: "tool-started", toolCallId, tool: toolName, args: input });
      return await this.finishSyntheticCall(call, sequence, { error: errorMessage }, errorMessage);
    }
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
      this.emit({ type: "error", message: result.error, recorded: true, fatal: false });
      return result;
    }
    const source = this.context.toolRegistry.listEntries().find((entry) => entry.tool.name === toolName)?.source ?? registered.source ?? "builtin";
    return await this.execute(registered, input, { toolCallId, abortSignal: signal } as ToolExecutionOptions<unknown>, source);
  }

  private async execute(toolDefinition: Tool, input: unknown, options: ToolExecutionOptions<unknown>, source: ToolSource): Promise<unknown> {
    // Tool calls are observed from fullStream before model-call-end starts the
    // batch. Yield once so every id in the batch can be classified before any
    // side effect is admitted.
    await Promise.resolve();
    const duplicate = this.duplicateToolCallIds.has(options.toolCallId);
    const sequence = this.nextSequence();
    const call = {
      id: duplicate ? this.duplicateAuditId(options.toolCallId, sequence) : options.toolCallId,
      name: toolDefinition.name,
      args: input
    };
    const signal = options.abortSignal;
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
    let toolResultRecorded = false;
    const finish = async (result: unknown, errorMessage?: string): Promise<unknown> => {
      toolResultRecorded = true;
      return await this.finishSyntheticCall(call, sequence, result, errorMessage);
    };

    try {
      if (duplicate) {
        this.emit({ type: "tool-started", toolCallId: call.id, tool: call.name, args: call.args });
        const message = `Duplicate tool call id was rejected before execution: ${options.toolCallId}.`;
        // The turn already emitted one fatal protocol error. Keep each rejected
        // call auditable through its tool_result without duplicating UI errors.
        return await finish({ error: message, duplicateToolCallId: true });
      }
      if (signal?.aborted) {
        this.emit({ type: "tool-started", toolCallId: call.id, tool: call.name, args: call.args });
        const message = abortedToolMessage(call.name, signal.reason);
        return await finish({ status: "aborted", error: message }, message);
      }

      return await this.admissionScheduler.schedule({
        accesses: ToolAccesses.none(),
        signal,
        start: async () => {
          signal?.throwIfAborted();
          const prepared = await this.prepareToolCall(toolDefinition, call, source, signal);
          if (!prepared.ok) {
            this.emit({ type: "tool-started", toolCallId: call.id, tool: call.name, args: call.args });
            return await finish(prepared.result, prepared.errorMessage);
          }

          this.emit({
            type: "tool-started",
            toolCallId: call.id,
            tool: call.name,
            args: call.args,
            description: prepared.execution.description,
            display: prepared.execution.display
          });

          signal?.throwIfAborted();
          const permissionSnapshot = await this.buildPermissionSnapshot(call, prepared.args, prepared.execution, toolDefinition.risk, signal);
          const permissionRequest = permissionSnapshot.request;
          signal?.throwIfAborted();
          const evaluation = this.permissionManager.evaluate(permissionRequest);
          let grantedPermission: AgentPermissionResult | undefined;
          if (evaluation.decision === "deny") {
            this.permissionManager.applyResult(permissionRequest, { approved: false, message: evaluation.reason });
            return await finish(deniedToolResult(permissionRequest, evaluation.reason));
          }

          if (evaluation.decision === "ask") {
            const permissionResult: AgentPermissionResult = await this.withPermissionGate(async () => {
              signal?.throwIfAborted();
              const gatedEvaluation = this.permissionManager.evaluate(permissionRequest);
              if (gatedEvaluation.decision === "deny") {
                const result = { approved: false as const, message: gatedEvaluation.reason };
                this.permissionManager.applyResult(permissionRequest, result);
                return result;
              }
              if (gatedEvaluation.decision === "allow") return { approved: true as const, scope: "once" as const };
              this.emit({ type: "permission-requested", toolCallId: call.id, request: permissionRequest });
              const result = this.context.confirmPermission
                ? await this.context.confirmPermission(permissionRequest)
                : await confirmPermissionRequest(permissionRequest);
              signal?.throwIfAborted();
              const validatedResult = validateStrongConfirmation(permissionRequest, result);
              this.permissionManager.applyResult(permissionRequest, validatedResult);
              if (validatedResult.approved) grantedPermission = validatedResult;
              this.emit({ type: "permission-result", toolCallId: call.id, request: permissionRequest, result: validatedResult });
              return validatedResult;
            }, signal);
            if (!permissionResult.approved) {
              return await finish(deniedToolResult(permissionRequest, permissionResult.message ?? "Denied by user."));
            }
          } else {
            this.permissionManager.applyResult(permissionRequest, { approved: true, scope: "once" });
          }

          const outcome = await this.scheduler.schedule({
            accesses: prepared.execution.accesses ?? ToolAccesses.all(),
            signal,
            start: async () => {
              signal?.throwIfAborted();
              if (permissionSnapshot.baseline) {
                let currentSnapshot: PermissionSnapshot;
                try {
                  currentSnapshot = await this.buildPermissionSnapshot(call, prepared.args, prepared.execution, toolDefinition.risk, signal);
                } catch (error) {
                  if (isAbortError(error, signal)) throw error;
                  this.permissionManager.revokeResult(permissionRequest, grantedPermission);
                  const message = `The target changed after the permission preview: ${formatToolError(call.name, error)} Retry the tool call to review and approve the current target.`;
                  return {
                    result: { status: "permission_required", approved: false, stalePreview: true, reason: message },
                    errorMessage: message
                  };
                }
                if (permissionSnapshot.targetPath !== currentSnapshot.targetPath
                  || !sameFileBaseline(permissionSnapshot.baseline, currentSnapshot.baseline)
                  || !samePermissionPreview(permissionRequest, currentSnapshot.request)) {
                  this.permissionManager.revokeResult(permissionRequest, grantedPermission);
                  const message = "The target changed after the permission preview. Retry the tool call to review and approve the updated contents.";
                  return {
                    result: { status: "permission_required", approved: false, stalePreview: true, reason: message },
                    errorMessage: message,
                    permissionRequest: currentSnapshot.request
                  };
                }
              }
              const approvedFile = permissionSnapshot.baseline && permissionSnapshot.targetPath
                ? { path: permissionSnapshot.targetPath, snapshot: permissionSnapshot.baseline.snapshot }
                : undefined;
              return await this.executeResolvedTool(call, prepared.execution, source, signal, approvedFile);
            }
          });
          const result = attachPermissionPreview(outcome.result, outcome.permissionRequest ?? permissionRequest);
          toolResultRecorded = true;
          this.context.recorder.record({ type: "tool_result", tool: call.name, result, toolCallId: call.id, sequence });
          this.context.contextMemory?.observeToolResult(call.name, call.args, result);
          if (outcome.errorMessage) {
            this.context.recorder.record({ type: "error", message: outcome.errorMessage });
            this.emit({ type: "error", message: outcome.errorMessage, recorded: true, fatal: false });
          }
          return result;
        }
      });
    } catch (error) {
      if (toolResultRecorded) throw error;
      const aborted = isAbortError(error, signal);
      const message = aborted ? abortedToolMessage(call.name, error) : formatToolError(call.name, error);
      return await finish(aborted ? { status: "aborted", error: message } : { error: message }, message);
    }
  }

  private async finishSyntheticCall(call: { id: string; name: string; args: unknown }, sequence: number, result: unknown, errorMessage?: string): Promise<unknown> {
    this.context.recorder.record({ type: "tool_result", tool: call.name, result, toolCallId: call.id, sequence });
    this.context.contextMemory?.observeToolResult(call.name, call.args, result);
    if (errorMessage) {
      this.context.recorder.record({ type: "error", message: errorMessage });
      this.emit({ type: "error", message: errorMessage, recorded: true, fatal: false });
    }
    return result;
  }

  private async prepareToolCall(
    toolDefinition: Tool,
    call: { id: string; name: string; args: unknown },
    source: ToolSource,
    signal?: AbortSignal
  ): Promise<PreparedToolCall | FailedPreparedToolCall> {
    let resolution: Promise<ToolExecution> | undefined;
    try {
      const schemaValidation = validateJsonSchema(toolDefinition.parameters, call.args);
      if (!schemaValidation.ok) {
        const message = `Invalid tool arguments for ${call.name}: ${schemaValidation.errors.join("; ")}`;
        return { ok: false, result: { error: message, validation: true }, errorMessage: message };
      }
      const args = toolDefinition.schema.parse(call.args);
      resolution = Promise.resolve(toolDefinition.resolveExecution(args));
      const execution = source === "builtin"
        ? await resolution
        : await waitForAbortWithDrain(resolution, signal, externalToolAbortDrainMs);
      if (isToolExecutionError(execution)) return { ok: false, result: execution.result, errorMessage: execution.errorMessage };
      return { ok: true, args, execution };
    } catch (error) {
      if (error instanceof ExternalToolQuarantineError && resolution) {
        this.context.quarantineExternalTool?.(call.name, call.id, resolution);
        const message = `Tool ${call.name} was aborted, but its external ${source} resolveExecution did not settle within ${String(externalToolAbortDrainMs)}ms. This agent session is quarantined until that resolution settles, so later operations cannot overlap its possible side effects.`;
        return {
          ok: false,
          result: {
            status: "aborted",
            quarantined: true,
            externalToolSource: source,
            stage: "resolveExecution",
            error: message
          },
          errorMessage: message
        };
      }
      if (isAbortError(error, signal)) throw error;
      const message = formatToolError(call.name, error);
      return {
        ok: false,
        result: error instanceof ZodError ? { error: message, validation: true } : { error: message },
        errorMessage: message
      };
    }
  }

  private async executeResolvedTool(
    call: { id: string; name: string },
    execution: RunnableToolExecution,
    source: ToolSource,
    signal?: AbortSignal,
    approvedFile?: ApprovedFileSnapshot
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    let executionPromise: Promise<unknown> | undefined;
    try {
      signal?.throwIfAborted();
      executionPromise = execution.execute({
        toolCallId: call.id,
        signal,
        onUpdate: (update) => {
          if (!signal?.aborted) this.emit({ type: "tool-progress", toolCallId: call.id, tool: call.name, update });
        },
        approvedFile
      });
      // Built-ins own a real cancellation contract, so their scheduler resources
      // remain held until the underlying operation has actually stopped. External
      // tools get a bounded drain so a non-cooperative extension cannot hang close.
      const result = source === "builtin"
        ? await executionPromise
        : await waitForAbortWithDrain(executionPromise, signal, externalToolAbortDrainMs);
      signal?.throwIfAborted();
      return { result: attachToolSummary(result, Date.now() - startedAt) };
    } catch (error) {
      if (error instanceof ExternalToolQuarantineError && executionPromise) {
        this.context.quarantineExternalTool?.(call.name, call.id, executionPromise);
        const message = `Tool ${call.name} was aborted, but its external ${source} execution did not settle within ${String(externalToolAbortDrainMs)}ms. This agent session is quarantined until that execution settles, so later operations cannot overlap its possible side effects.`;
        return {
          result: {
            status: "aborted",
            quarantined: true,
            externalToolSource: source,
            error: message,
            durationMs: Date.now() - startedAt
          },
          errorMessage: message
        };
      }
      const message = formatToolError(call.name, error);
      const aborted = isAbortError(error, signal);
      return {
        result: aborted
          ? { status: "aborted", error: message, durationMs: Date.now() - startedAt }
          : { error: message, durationMs: Date.now() - startedAt },
        errorMessage: message
      };
    }
  }

  private async buildPermissionRequest(
    call: { id: string; name: string; args: unknown },
    args: unknown,
    execution: RunnableToolExecution,
    toolRisk: ToolRisk | undefined
  ): Promise<AgentPermissionRequest> {
    const permissionArgs = this.canonicalPermissionArgs(args, execution);
    const permissionContext = analyzePermissionRequest({
      toolName: call.name,
      args: permissionArgs,
      sessionId: this.context.recorder.sessionId,
      projectRoot: this.context.workspaceRoot,
      toolRisk
    });
    const request = await createToolPermissionRequest({ id: call.id, name: call.name, args: permissionArgs }, {
      workspaceRoot: this.context.workspaceRoot,
      ignore: this.context.config.workspace.ignore,
      sessionId: this.context.recorder.sessionId
    }, permissionContext);
    return {
      ...request,
      approvalRule: permissionApprovalFingerprint(execution.approvalRule, permissionArgs),
      reason: execution.description ?? request.reason,
      changeSummary: request.changeSummary ?? displaySummary(execution.display)
    };
  }

  private canonicalPermissionArgs(args: unknown, execution: RunnableToolExecution): unknown {
    if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return args;
    if (args.path.startsWith("@attachments/")) return args;
    const declaredPath = execution.accesses?.find((access) => access.kind === "file")?.path;
    if (!declaredPath) return args;
    const relative = toWorkspaceRelative(this.context.workspaceRoot, declaredPath);
    const firstSegment = relative.split(/[\\/]+/u)[0];
    if (relative === "." || firstSegment === "..") return args;
    return { ...args, path: relative };
  }

  private async buildPermissionSnapshot(
    call: { id: string; name: string; args: unknown },
    args: unknown,
    execution: RunnableToolExecution,
    toolRisk: ToolRisk | undefined,
    signal?: AbortSignal
  ): Promise<PermissionSnapshot> {
    signal?.throwIfAborted();
    const targetPath = this.resolvePermissionTarget(call.name, args, execution);
    const before = await this.captureFileBaseline(targetPath, signal);
    signal?.throwIfAborted();
    const request = await this.buildPermissionRequest(call, args, execution, toolRisk);
    signal?.throwIfAborted();
    if (!before) return { request, baseline: undefined, targetPath: undefined };

    const currentTargetPath = this.resolvePermissionTarget(call.name, args, execution);
    const after = await this.captureFileBaseline(currentTargetPath, signal);
    if (targetPath !== currentTargetPath || !sameFileBaseline(before, after)) {
      throw new Error("The target changed while the permission preview was being generated. Retry the tool call to review the current contents.");
    }
    return { request, baseline: after, targetPath };
  }

  private resolvePermissionTarget(toolName: string, args: unknown, execution: RunnableToolExecution): string | undefined {
    if (toolName !== "write_file" && toolName !== "edit_file" && toolName !== "multi_edit" && toolName !== "delete_file" && toolName !== "apply_patch" && toolName !== "move_file") return undefined;
    const requestedPath = toolName === "move_file" ? readStringField(args, "from") : readStringField(args, "path");
    if (!requestedPath) return undefined;
    const resolvedPath = resolveWorkspacePath(this.context.workspaceRoot, requestedPath, this.context.config.workspace.ignore);
    const declaredPath = execution.accesses?.find((access) => access.kind === "file")?.path;
    if (declaredPath && declaredPath !== resolvedPath) {
      throw new Error("The target path changed after the tool call was prepared. Retry the tool call to review the current target.");
    }
    return declaredPath ?? resolvedPath;
  }

  private async captureFileBaseline(absolutePath: string | undefined, signal?: AbortSignal): Promise<FilePermissionBaseline | undefined> {
    if (!absolutePath) return undefined;
    try {
      const { content, snapshot } = await readBoundedUtf8File(absolutePath, maxEditFileBytes, "reject", signal);
      return { exists: true, content, snapshot };
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) return { exists: false, content: "", snapshot: null };
      throw error;
    }
  }

  private nextSequence(): number {
    return this.context.recorder.nextToolCallSequence?.() ?? ++this.fallbackSequence;
  }

  private duplicateAuditId(toolCallId: string, sequence: number): string {
    const count = (this.duplicateExecutionCounts.get(toolCallId) ?? 0) + 1;
    this.duplicateExecutionCounts.set(toolCallId, count);
    return `${toolCallId}:duplicate:${String(count)}:${String(sequence)}`;
  }

  private trackExecution<T>(execution: Promise<T>): Promise<T> {
    this.pendingExecutions.add(execution);
    void execution.then(
      () => this.pendingExecutions.delete(execution),
      () => this.pendingExecutions.delete(execution)
    );
    return execution;
  }

  private async withPermissionGate<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.permissionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.permissionTail = current;
    try {
      await waitForAbort(previous, signal);
      signal?.throwIfAborted();
      return await waitForAbort(fn(), signal);
    } finally {
      release();
    }
  }
}

function validateStrongConfirmation(
  request: AgentPermissionRequest,
  result: AgentPermissionResult
): AgentPermissionResult {
  if (!request.requireFullYes || !result.approved || isFullYesConfirmation(result.confirmation ?? "")) return result;
  return {
    approved: false,
    scope: "once",
    message: "Full yes confirmation was not provided.",
    confirmation: result.confirmation
  };
}

function permissionApprovalFingerprint(approvalRule: string, args: unknown): string {
  const input = `${approvalRule}\0${stableJson(args)}`;
  return createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isToolExecutionError(execution: unknown): execution is { isError: true; result: unknown; errorMessage: string } {
  return typeof execution === "object" && execution !== null && "isError" in execution && execution.isError === true && "errorMessage" in execution && typeof execution.errorMessage === "string";
}

function formatToolError(toolName: string, error: unknown): string {
  if (error instanceof ZodError) return `Invalid tool arguments for ${toolName}: ${error.issues.map((issue) => issue.message).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortedToolMessage(toolName: string, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "The operation was aborted.";
  return `Tool ${toolName} was aborted: ${detail}`;
}

function sameFileBaseline(left: FilePermissionBaseline | undefined, right: FilePermissionBaseline | undefined): boolean {
  if (!left || !right) return left === right;
  return left.exists === right.exists
    && left.content === right.content
    && sameOptionalFileSnapshot(left.snapshot, right.snapshot);
}

function samePermissionPreview(left: AgentPermissionRequest, right: AgentPermissionRequest): boolean {
  return left.details === right.details
    && left.diff === right.diff
    && left.preview === right.preview
    && left.changeSummary === right.changeSummary;
}

function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function waitForAbortWithDrain<T>(promise: Promise<T>, signal: AbortSignal | undefined, drainMs: number): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    const settled = await drainPromise(promise, drainMs);
    if (!settled) throw new ExternalToolQuarantineError(abortReason(signal));
    throw abortReason(signal);
  }

  const outcome = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error })
  );
  let onAbort!: () => void;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const first = await Promise.race([outcome, aborted]);
  signal.removeEventListener("abort", onAbort);
  if (first.kind === "value") return first.value;
  if (first.kind === "error") throw first.error;
  const settled = await Promise.race([
    outcome.then(() => true),
    delay(drainMs).then(() => false)
  ]);
  if (!settled) throw new ExternalToolQuarantineError(abortReason(signal));
  throw abortReason(signal);
}

async function drainPromise(promise: Promise<unknown>, drainMs: number): Promise<boolean> {
  const settled = promise.then(() => true, () => true);
  return await Promise.race([settled, delay(drainMs).then(() => false)]);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

class ExternalToolQuarantineError extends Error {
  constructor(readonly abortCause: unknown) {
    super("The cancelled external tool did not settle during its bounded drain.");
    this.name = "ExternalToolQuarantineError";
  }
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
