import { promises as fs } from "node:fs";
import path from "node:path";
import { stepCountIs, streamText, ToolLoopAgent, type LanguageModel, type LanguageModelUsage, type ModelMessage, type TextStreamPart, type ToolLoopAgentSettings, type ToolSet } from "ai";
import type { AgentConfig } from "../config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import {
  listModelChoices,
  modelRuntimeInfo,
  type ModelChoice,
  type ModelManager,
  type ModelRuntimeInfo,
  type ThinkingSelection
} from "../llm/ModelManager.js";
import { PermissionManager, type PermissionMode } from "../permission/PermissionManager.js";
import { runPermissionCommand } from "../permission/commands.js";
import { listSessionSummaries, parseSessionEvents, type SessionSummary } from "../session/events.js";
import { SessionRecorder } from "../session/recorder.js";
import { replaySessionEvents, type SessionReplay } from "../session/replay.js";
import { ensureAgentDirs, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SdkToolExecutionCoordinator } from "./sdkToolExecutionCoordinator.js";
import { buildSystemPrompt } from "./prompts.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResult,
  AgentRuntimeContext,
  AgentSessionEvent,
  AgentTurnOutcome
} from "./types.js";
import { ContextMemory } from "./context/ContextMemory.js";
import { LocalMemory } from "./context/LocalMemory.js";
import { WorkspaceContext } from "./context/WorkspaceContext.js";
import type { ContextStatus } from "./context/types.js";
import { createSdkTelemetry } from "../observability/telemetry.js";
import { createSessionUsage, formatUsageSummary, summarizeUsage, type UsageModelInfo } from "../observability/usage.js";
import type { SessionUsage } from "../session/metadata.js";
import { AsyncEventQueue } from "../runtime/AsyncEventQueue.js";
import { modelContextBudget } from "../ai/capabilities.js";
import { modelCapabilities } from "../ai/capabilities.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  persistenceRoot?: string;
  configStore?: AgentConfigStore;
  config: AgentConfig;
  model?: LanguageModel;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  recorder: SessionRecorder;
  modelManager?: ModelManager;
  taskStatePrompt?: () => Promise<string | undefined>;
  skillPrompt?: string;
  skillPaths?: string[];
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  mode?: AgentRunMode;
  /** Per-attempt cap, bounded by the configured circuit breaker. */
  maxSteps?: number;
  /** A task harness may defer success memory until external acceptance checks pass. */
  deferSuccessfulMemory?: boolean;
  attachments?: AgentAttachment[];
}

export interface AgentAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface AgentSessionInfo {
  workspaceRoot: string;
  sessionId: string;
  sessionFile: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  modelAlias: string;
  thinking: ThinkingSelection;
  skills?: string[];
}

export type AgentRunMode = "chat" | "plan";

export interface ResumedAgentSession extends SessionReplay {
  filePath: string;
  sessionId: string;
}

/**
 * Stateful core agent for one workspace. Hosts use this public surface instead
 * of reaching into the model, recorder, tools or mutable conversation directly.
 */
export class AgentSession {
  private readonly contextMemory: ContextMemory;
  private usageRecords: SessionUsage[] = [];
  private unpersistedRelatedUsage: SessionUsage[] = [];
  private recorder: SessionRecorder;
  private activeOperation: string | undefined;
  private readonly lingeringExternalTools = new Map<Promise<unknown>, { tool: string; toolCallId: string }>();

  constructor(private readonly options: AgentSessionOptions) {
    const persistenceRoot = this.persistenceRoot();
    const workspace = new WorkspaceContext(
      options.workspaceRoot,
      options.config.workspace.ignore,
      options.config.context.instructionsMaxBytes
    );
    const getModel = (): LanguageModel => {
      const model = options.modelManager?.getModel() ?? options.model;
      if (!model) throw new Error("Vercel AI SDK model is not configured.");
      return model;
    };
    const onUsage = async (usage: LanguageModelUsage, operation: "agent" | "plan" | "compaction" | "memory" | "subagent"): Promise<void> => {
      this.recordModelUsage(usage, operation);
    };
    const telemetry = (functionId: string) => createSdkTelemetry(options.config, persistenceRoot, functionId);
    const localMemory = options.config.context.memory.enabled
      ? new LocalMemory(persistenceRoot, getModel, onUsage, telemetry, () => options.modelManager?.getModelSettings().maxRetries ?? 0)
      : undefined;
    this.contextMemory = new ContextMemory(
      getModel,
      workspace,
      localMemory,
      options.config.context.maxInputTokens,
      options.config.context.instructionsMaxBytes,
      onUsage,
      telemetry,
      () => {
        const activeModel = options.config.models[options.config.defaultModel];
        if (!activeModel) {
          return {
            modelAlias: options.config.defaultModel,
            contextWindow: options.config.context.maxInputTokens,
            maxInputTokens: options.config.context.maxInputTokens,
            maxOutputTokens: undefined
          };
        }
        return modelContextBudget(activeModel, options.config.context.maxInputTokens, options.config.defaultModel);
      },
      () => options.modelManager?.getModelSettings().maxRetries ?? 0
    );
    this.recorder = options.recorder;
  }

  async initialize(): Promise<void> {
    await this.contextMemory.initialize();
  }

  async *run(input: string, runOptions: AgentRunOptions = {}): AsyncGenerator<AgentSessionEvent> {
    yield* this.runSdk(input, runOptions);
  }

  async *runSdk(input: string, runOptions: AgentRunOptions = {}): AsyncGenerator<AgentSessionEvent> {
    const release = this.beginOperation("agent turn");
    const turnController = new AbortController();
    const abortSignal = runOptions.abortSignal
      ? AbortSignal.any([runOptions.abortSignal, turnController.signal])
      : turnController.signal;
    const effectiveRunOptions: AgentRunOptions = { ...runOptions, abortSignal };
    const usageBeforePreparation = this.usageRecords.length;
    let userMessageRecorded = false;
    const recordUserMessage = (): void => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      this.recorder.record({
        type: "user_message",
        content: input,
        skills: this.options.skillPaths,
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        preparationUsage: this.usageRecords.slice(usageBeforePreparation)
      });
    };
    let streamTask: Promise<void> | undefined;
    try {
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = abortedTurn("Current turn interrupted before execution.", 0);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "aborted" };
      yield doneEvent(outcome);
      return;
    }
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) {
      recordUserMessage();
      const outcome = failedTurn("Vercel AI SDK model is not configured.", 0);
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }
    const settings = this.options.modelManager?.getModelSettings();
    const mode = runOptions.mode ?? "chat";
    let messages: ModelMessage[];
    try {
      const durableTaskPrompt = await this.options.taskStatePrompt?.();
      const systemPrompt = [
        buildSystemPrompt(mode === "plan" ? "plan" : "qa", this.options.skillPrompt),
        durableTaskPrompt
      ].filter((section): section is string => Boolean(section)).join("\n\n");
      messages = await this.contextMemory.prepareTurn(
        input,
        systemPrompt,
        abortSignal,
        supportedAttachments(this.options.config, runOptions.attachments)
      );
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? abortedTurn("Current turn interrupted during context preparation.", 0)
        : failedTurn(errorMessage(error), 0, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "aborted" ? "aborted" : "error" };
      yield doneEvent(outcome);
      return;
    }
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = abortedTurn("Current turn interrupted during context preparation.", 0);
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "aborted" };
      yield doneEvent(outcome);
      return;
    }
    const permissionManager = this.options.permissionManager;
    const maxSteps = runOptions.maxSteps ?? this.options.config.agent.maxSteps;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > this.options.config.agent.maxSteps) {
      throw new RangeError(`Agent attempt maxSteps must be between 1 and ${String(this.options.config.agent.maxSteps)}.`);
    }
    const stepContext = { assistantContent: "", reasoningContent: "" };
    const queue = new AsyncEventQueue<AgentSessionEvent>();
    const runtime = this.runtimeContext(effectiveRunOptions);
    const allowedToolNames = mode === "plan"
      ? new Set(this.options.toolRegistry.list().filter((tool) => tool.risk === "read").map((tool) => tool.name))
      : undefined;
    const coordinator = new SdkToolExecutionCoordinator(
      runtime,
      permissionManager,
      (event) => queue.push(event),
      () => ({ ...stepContext }),
      allowedToolNames
    );
    const agentSettings = {
      model,
      tools: coordinator.createTools(),
      allowSystemInMessages: true,
      stopWhen: stepCountIs(maxSteps),
      maxRetries: settings?.maxRetries ?? 0,
      providerOptions: settings?.providerOptions,
      reasoning: settings?.reasoning,
      timeout: settings?.timeoutMs,
      maxOutputTokens: settings?.maxOutputTokens,
      telemetry: createSdkTelemetry(this.options.config, this.persistenceRoot(), "biny.agent"),
      // ToolLoopAgent forwards unknown stream options to streamText at runtime;
      // suppress its console.error default so Ink remains the only output sink.
      onError: () => undefined
    } as ToolLoopAgentSettings<never, ToolSet> & { onError: () => undefined };
    const agent = new ToolLoopAgent<never, ToolSet>(agentSettings);

    recordUserMessage();
    yield { type: "status", status: "thinking" };

    let result: Awaited<ReturnType<typeof agent.stream>>;
    try {
      result = await agent.stream({ messages, abortSignal });
    } catch (error) {
      const message = errorMessage(error);
      const outcome = runOptions.abortSignal?.aborted
        ? abortedTurn(message || "Current turn interrupted.", 0)
        : failedTurn(message, 0, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(message);
      yield { type: "error", message };
      yield { type: "status", status: outcome.status === "aborted" ? "aborted" : "error" };
      yield doneEvent(outcome);
      return;
    }

    let streamError: unknown;
    let observedSteps = 0;
    const invalidToolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }> = [];
    let duplicateToolCallError: Error | undefined;
    let streamFailureReported = false;
    streamTask = (async (): Promise<void> => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "start-step") {
            observedSteps += 1;
            stepContext.assistantContent = "";
            stepContext.reasoningContent = "";
          } else if (part.type === "text-delta") {
            stepContext.assistantContent += part.text;
          } else if (part.type === "reasoning-delta") {
            stepContext.reasoningContent += part.text;
          } else if (part.type === "error") {
            streamError = part.error;
          }
          if (part.type === "tool-call") {
            const duplicateMessage = coordinator.observeToolCall(part.toolCallId);
            if (duplicateMessage && !duplicateToolCallError) {
              duplicateToolCallError = new Error(duplicateMessage);
              streamError = duplicateToolCallError;
              streamFailureReported = true;
              queue.push({ type: "error", message: duplicateMessage, fatal: true });
              turnController.abort(duplicateToolCallError);
            }
            if (part.invalid) invalidToolCalls.push({ toolName: part.toolName, toolCallId: part.toolCallId, input: part.input });
          }
          queue.push({ type: "sdk", part: part as TextStreamPart<ToolSet> });
        }
      } catch (error) {
        streamError = error;
        streamFailureReported = true;
        queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!duplicateToolCallError) {
          await Promise.all(invalidToolCalls.map(async (call) => {
            await coordinator.handleInvalidToolCall(call.toolName, call.toolCallId, call.input, abortSignal);
          }));
        }
        await coordinator.waitForIdle();
        queue.close();
      }
    })();

    for await (const event of queue) {
      yield event;
      // Acknowledge after the host asked for the next event, so producers can
      // distinguish buffered events from facts the host has actually handled.
      queue.ackConsumed();
    }
    await streamTask;

    try {
      const [content, reasoningContent, responseMessages, usage, finalStep, steps] = await Promise.all([
        result.text,
        result.reasoningText,
        result.responseMessages,
        result.usage,
        result.finalStep,
        result.steps
      ]);
      // A provider can surface an error as a fullStream part while still
      // resolving the convenience promises with partial output. Do not let a
      // partial answer commit history or look like a successful turn.
      if (streamError !== undefined) throw streamError;
      this.contextMemory.recordProviderUsage(finalStep.usage.inputTokens !== undefined ? finalStep.usage : usage);
      const nextMessages = [...messages, ...responseMessages];
      this.contextMemory.replaceHistory(nextMessages);
      const usageRecord = this.recordModelUsage(usage, "agent");
      this.recorder.record({
        type: "assistant_message",
        content,
        reasoningContent: reasoningContent ?? undefined,
        usage: usageRecord,
        relatedUsage: this.takeRelatedUsage(),
        contextState: this.contextMemory.snapshot()
      });
      const outcome = finishedTurn(
        content,
        finalStep.finishReason,
        steps.length,
        maxSteps,
        usageRecord
      );
      if (outcome.status === "completed") {
        if (!runOptions.deferSuccessfulMemory) this.contextMemory.queueSuccessfulTask(input, content);
        yield { type: "status", status: "completed" };
      } else if (outcome.status === "incomplete") {
        yield { type: "status", status: "incomplete" };
      } else {
        this.recordError(outcome.error ?? `Agent stopped with finish reason ${outcome.finishReason ?? "unknown"}.`);
        yield { type: "error", message: outcome.error ?? "Agent run failed." };
        yield { type: "status", status: "error" };
      }
      yield doneEvent(outcome);
    } catch (error) {
      const failure = streamError ?? error;
      const message = errorMessage(failure);
      const outcome = runOptions.abortSignal?.aborted
        ? abortedTurn(message || "Current turn interrupted.", observedSteps)
        : failedTurn(message, observedSteps, isTimeoutFailure(failure) ? "timeout" : "provider_error");
      this.recordError(message);
      if (!streamFailureReported) yield { type: "error", message };
      yield { type: "status", status: outcome.status === "aborted" ? "aborted" : "error" };
      yield doneEvent(outcome);
    }
    } finally {
      turnController.abort(new Error("Agent turn stream was closed."));
      try {
        await streamTask;
      } finally {
        release();
      }
    }
  }

  async runTask(input: string, runOptions: AgentRunOptions = {}): Promise<AgentTurnOutcome> {
    let outcome: AgentTurnOutcome | undefined;
    try {
      for await (const event of this.run(input, runOptions)) {
        if (event.type === "done") outcome = event.outcome;
      }
    } catch (error) {
      const message = errorMessage(error);
      this.recordError(message);
      return failedTurn(message, 0, isTimeoutFailure(error) ? "timeout" : "provider_error");
    }
    return outcome ?? failedTurn("Agent stream ended without a terminal result.", 0);
  }

  async createPlan(task: string, onDelta?: (delta: string) => void, abortSignal?: AbortSignal): Promise<string> {
    const release = this.beginOperation("plan creation");
    const userContent = `plan: ${task}`;
    const usageBeforePreparation = this.usageRecords.length;
    let userMessageRecorded = false;
    const recordUserMessage = (): void => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      this.recorder.record({
        type: "user_message",
        content: userContent,
        skills: this.options.skillPaths,
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        preparationUsage: this.usageRecords.slice(usageBeforePreparation)
      });
    };
    try {
      if (abortSignal?.aborted) {
        recordUserMessage();
        throw new Error("Plan creation was interrupted before execution.");
      }
      let messages: ModelMessage[];
      try {
        messages = await this.contextMemory.prepareTurn(task, buildSystemPrompt("oneShotPlan", this.options.skillPrompt), abortSignal);
      } catch (error) {
        recordUserMessage();
        throw error;
      }
      recordUserMessage();
      const model = this.options.modelManager?.getModel() ?? this.options.model;
      if (!model) throw new Error("Vercel AI SDK model is not configured.");
      const result = streamText({
        model,
        messages,
        allowSystemInMessages: true,
        abortSignal,
        maxRetries: this.options.modelManager?.getModelSettings().maxRetries ?? 0,
        providerOptions: this.options.modelManager?.getModelSettings().providerOptions,
        reasoning: this.options.modelManager?.getModelSettings().reasoning,
        timeout: this.options.modelManager?.getModelSettings().timeoutMs,
        maxOutputTokens: this.options.modelManager?.getModelSettings().maxOutputTokens,
        telemetry: createSdkTelemetry(this.options.config, this.persistenceRoot(), "biny.plan"),
        onError: () => undefined
      });
      for await (const delta of result.textStream) onDelta?.(delta);
      const output = await result.text;
      const [usage, finalStep] = await Promise.all([result.usage, result.finalStep]);
      this.contextMemory.recordProviderUsage(finalStep.usage.inputTokens !== undefined ? finalStep.usage : usage);
      this.contextMemory.replaceHistory([
        ...this.contextMemory.getHistory(),
        { role: "user", content: userContent },
        { role: "assistant", content: output }
      ]);
      this.recorder.record({
        type: "assistant_message",
        content: output,
        reasoningContent: undefined,
        usage: this.recordModelUsage(usage, "plan"),
        contextState: this.contextMemory.snapshot()
      });
      if (finalStep.finishReason !== "stop") {
        throw new Error(`Plan generation did not reach a terminal model stop (finishReason=${finalStep.finishReason}).`);
      }
      this.contextMemory.queueSuccessfulTask(userContent, output);
      return output;
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      release();
    }
  }

  async resume(session: string | undefined): Promise<ResumedAgentSession> {
    const release = this.beginOperation("session resume");
    try {
    await ensureAgentDirs(this.persistenceRoot());
    const filePath = await resolveSessionFile(this.persistenceRoot(), session);
    const previousRecorder = this.recorder;
    const previousFilePath = await fs.realpath(previousRecorder.filePath).catch(() => path.resolve(previousRecorder.filePath));
    const resumingCurrent = filePath === previousFilePath;
    let previousClosed = false;
    let replacementRecorder: SessionRecorder | undefined;
    try {
      if (resumingCurrent) {
        previousClosed = true;
        await previousRecorder.close();
      }
      replacementRecorder = new SessionRecorder(this.persistenceRoot(), sessionIdFromFile(filePath), filePath);
      replacementRecorder.repairTailForAppend();
      const replay = replaySessionEvents(parseSessionEvents(replacementRecorder.readText()));
      replacementRecorder.restoreToolCallSequence(maxToolCallSequence(replay.events));

      if (!resumingCurrent) {
        previousClosed = true;
        await previousRecorder.close();
      }
      for (const event of replay.recoveredToolResults) replacementRecorder.record(event);
      this.options.permissionManager.resetSession();
      this.usageRecords = [...replay.usage];
      this.unpersistedRelatedUsage = [];
      this.contextMemory.restore(replay.messages, replay.contextState ?? replay.contextUsage);
      this.recorder = replacementRecorder;
      return { ...replay, filePath, sessionId: replacementRecorder.sessionId };
    } catch (error) {
      await replacementRecorder?.close().catch(() => undefined);
      if (previousClosed) {
        this.recorder = new SessionRecorder(this.persistenceRoot());
      }
      throw error;
    }
    } finally {
      release();
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await listSessionSummaries(this.persistenceRoot());
  }

  async contextReport(): Promise<string> {
    return await this.contextMemory.describe();
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.contextMemory.status();
  }

  usageReport(): string {
    return formatUsageSummary(summarizeUsage(this.usageRecords));
  }

  observeModelUsage(
    usage: LanguageModelUsage,
    operation: "agent" | "plan" | "compaction" | "memory" | "subagent",
    modelAlias?: string
  ): void {
    this.recordModelUsage(usage, operation, modelAlias);
  }

  rememberSuccessfulTask(task: string, answer: string): void {
    this.contextMemory.queueSuccessfulTask(task, answer);
  }

  async compactConversation(hint?: string, signal?: AbortSignal): Promise<string> {
    const release = this.beginOperation("conversation compaction");
    try {
    const usageBeforeCompaction = this.usageRecords.length;
    const result = await this.contextMemory.compact(hint, signal);
    const compactionUsage = this.usageRecords.slice(usageBeforeCompaction).at(-1);
    this.recorder.record({
      type: "assistant_message",
      content: "",
      reasoningContent: undefined,
      usage: compactionUsage,
      contextState: this.contextMemory.snapshot()
    });
    return this.contextMemory.formatCompaction(result);
    } finally {
      release();
    }
  }

  listModels(): ModelChoice[] {
    return this.options.modelManager?.listModels() ?? listModelChoices(this.options.config);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const release = this.beginOperation("model switch");
    try {
    if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
    return await this.options.modelManager.switchModel(alias, thinking);
    } finally {
      release();
    }
  }

  async refreshModelFromDisk(): Promise<ModelRuntimeInfo> {
    const release = this.beginOperation("model refresh");
    try {
    if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
    return await this.options.modelManager.refreshFromDisk();
    } finally {
      release();
    }
  }

  getInfo(): AgentSessionInfo {
    const model = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    return {
      workspaceRoot: this.options.workspaceRoot,
      sessionId: this.recorder.sessionId,
      sessionFile: this.recorder.filePath,
      ...model,
      skills: this.options.skillPaths
    };
  }

  getPermissionMode(): PermissionMode {
    return this.options.permissionManager.getStatus().mode;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const release = this.beginOperation("permission update");
    const previousMode = this.options.permissionManager.getStatus().mode;
    try {
      this.options.permissionManager.setMode(mode);
      this.options.config.permission.mode = mode;
      await this.configStore().save(this.options.config);
    } catch (error) {
      this.options.permissionManager.setMode(previousMode);
      this.options.config.permission.mode = previousMode;
      throw error;
    } finally {
      release();
    }
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    const release = this.beginOperation("permission command");
    const previousMode = this.options.permissionManager.getStatus().mode;
    try {
      const output = runPermissionCommand(this.options.permissionManager, args);
      if (this.options.permissionManager.getStatus().mode !== previousMode) {
        this.options.config.permission.mode = this.options.permissionManager.getStatus().mode;
        try {
          await this.configStore().save(this.options.config);
        } catch (error) {
          this.options.permissionManager.setMode(previousMode);
          this.options.config.permission.mode = previousMode;
          throw error;
        }
      }
      return output;
    } finally {
      release();
    }
  }

  recordError(error: unknown): void {
    this.recorder.record({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      relatedUsage: this.takeRelatedUsage()
    });
  }

  recordHostedUserMessage(content: string): void {
    this.assertNotQuarantined("hosted user message");
    this.recorder.record({
      type: "user_message",
      content,
      skills: this.options.skillPaths,
      auditOnly: true
    });
  }

  recordHostedAssistantMessage(content: string): void {
    this.recorder.record({ type: "assistant_message", content, auditOnly: true });
  }

  recordHostedToolCall(tool: string, args: unknown, toolCallId: string): number {
    this.assertNotQuarantined("hosted tool call");
    const sequence = this.recorder.nextToolCallSequence();
    this.recorder.record({ type: "tool_call", tool, args, toolCallId, sequence, auditOnly: true });
    return sequence;
  }

  recordHostedToolResult(tool: string, result: unknown, toolCallId: string, sequence: number): void {
    this.recorder.record({
      type: "tool_result",
      tool,
      result,
      toolCallId,
      sequence,
      relatedUsage: this.takeRelatedUsage(),
      auditOnly: true
    });
  }

  async close(): Promise<void> {
    await this.contextMemory.shutdownMemory();
    const relatedUsage = this.takeRelatedUsage();
    if (relatedUsage) {
      this.recorder.record({
        type: "assistant_message",
        content: "",
        relatedUsage,
        contextState: this.contextMemory.persistedState()
      });
    }
    await this.recorder.close();
  }

  private beginOperation(operation: string): () => void {
    if (this.activeOperation) throw new Error(`Cannot start ${operation} while ${this.activeOperation} is running.`);
    this.assertNotQuarantined(operation);
    this.activeOperation = operation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperation = undefined;
    };
  }

  private assertNotQuarantined(operation: string): void {
    const lingering = this.lingeringExternalTools.values().next().value as { tool: string; toolCallId: string } | undefined;
    if (lingering) {
      throw new Error(`Cannot start ${operation}: this agent session is quarantined while cancelled external tool ${lingering.tool} (${lingering.toolCallId}) is still settling.`);
    }
  }

  private recordModelUsage(
    usage: LanguageModelUsage,
    operation: "agent" | "plan" | "compaction" | "memory" | "subagent",
    modelAlias?: string
  ): SessionUsage {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    const info = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    const resolvedAlias = modelAlias ?? info.modelAlias;
    const resolved = this.options.config.models[resolvedAlias];
    const provider = resolved ? this.options.config.providers[resolved.provider] : undefined;
    const modelInfo: UsageModelInfo = {
      modelAlias: resolvedAlias,
      provider: provider?.type ?? info.provider,
      model: resolved?.model ?? (model ? modelIdentifier(model) : info.modelLabel),
      pricing: resolved?.pricing
    };
    const record = createSessionUsage(usage, operation, modelInfo);
    this.usageRecords.push(record);
    if (operation === "subagent" || operation === "memory") this.unpersistedRelatedUsage.push(record);
    return record;
  }

  private takeRelatedUsage(): SessionUsage[] | undefined {
    if (!this.unpersistedRelatedUsage.length) return undefined;
    return this.unpersistedRelatedUsage.splice(0, this.unpersistedRelatedUsage.length);
  }

  private runtimeContext(runOptions: AgentRunOptions): AgentRuntimeContext {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) throw new Error("Vercel AI SDK model is not configured.");
    return {
      workspaceRoot: this.options.workspaceRoot,
      config: this.options.config,
      model,
      recorder: this.recorder,
      contextMemory: this.contextMemory,
      toolRegistry: this.options.toolRegistry,
      permissionManager: this.options.permissionManager,
      confirmPermission: runOptions.confirmPermission,
      quarantineExternalTool: (tool, toolCallId, settlement) => {
        if (this.lingeringExternalTools.has(settlement)) return;
        this.lingeringExternalTools.set(settlement, { tool, toolCallId });
        void settlement.then(
          () => this.lingeringExternalTools.delete(settlement),
          () => this.lingeringExternalTools.delete(settlement)
        );
      },
      abortSignal: runOptions.abortSignal
    };
  }

  private persistenceRoot(): string {
    return this.options.persistenceRoot ?? this.options.workspaceRoot;
  }

  private configStore(): AgentConfigStore {
    return this.options.configStore ?? createFileConfigStore(this.persistenceRoot());
  }
}

function modelIdentifier(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function maxToolCallSequence(events: SessionReplay["events"]): number {
  return events.reduce((maximum, event) => {
    if ((event.type !== "tool_call" && event.type !== "tool_result") || typeof event.sequence !== "number") return maximum;
    return Math.max(maximum, event.sequence);
  }, 0);
}

function doneEvent(outcome: AgentTurnOutcome): Extract<AgentSessionEvent, { type: "done" }> {
  return {
    type: "done",
    content: outcome.output,
    usage: outcome.usage,
    outcome
  };
}

function finishedTurn(
  output: string,
  finishReason: string,
  steps: number,
  maxSteps: number,
  usage: SessionUsage
): AgentTurnOutcome {
  if (finishReason === "stop") {
    return { status: "completed", stopReason: "model_stop", finishReason, steps, output, usage };
  }
  if (finishReason === "tool-calls") {
    return {
      status: "incomplete",
      stopReason: steps >= maxSteps ? "step_limit" : "tool_pending",
      finishReason,
      steps,
      output,
      usage
    };
  }
  if (finishReason === "length") {
    return {
      status: "incomplete",
      stopReason: "model_length",
      finishReason,
      steps,
      output,
      usage,
      error: "The model reached its output limit before completing the turn."
    };
  }
  if (finishReason === "content-filter") {
    return {
      status: "failed",
      stopReason: "content_filter",
      finishReason,
      steps,
      output,
      usage,
      error: "The model response was stopped by the provider content filter."
    };
  }
  return {
    status: "failed",
    stopReason: "provider_error",
    finishReason,
    steps,
    output,
    usage,
    error: `The model stopped without a successful terminal response (${finishReason || "unknown"}).`
  };
}

function failedTurn(
  message: string,
  steps: number,
  stopReason: "timeout" | "provider_error" = "provider_error"
): AgentTurnOutcome {
  return {
    status: "failed",
    stopReason,
    finishReason: undefined,
    steps,
    output: "",
    usage: undefined,
    error: message || "Agent run failed."
  };
}

function abortedTurn(message: string, steps: number): AgentTurnOutcome {
  return {
    status: "aborted",
    stopReason: "aborted",
    finishReason: undefined,
    steps,
    output: "",
    usage: undefined,
    error: message
  };
}

function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|deadline/i.test(`${error.name} ${error.message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportedAttachments(config: AgentConfig, attachments: AgentAttachment[] | undefined): AgentAttachment[] {
  if (!attachments?.length) return [];
  const model = config.models[config.defaultModel];
  if (!model) return [];
  const capabilities = modelCapabilities(model);
  return attachments.filter((attachment) => {
    if (attachment.mimeType.startsWith("image/")) return capabilities.vision;
    if (attachment.mimeType.startsWith("audio/")) return capabilities.audio;
    return capabilities.vision;
  });
}
