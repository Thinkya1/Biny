import { promises as fs } from "node:fs";
import { stepCountIs, streamText, ToolLoopAgent, type LanguageModel, type LanguageModelUsage, type TextStreamPart, type ToolLoopAgentSettings, type ToolSet } from "ai";
import type { AgentConfig } from "../config/schema.js";
import { saveConfig } from "../config/loader.js";
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
import { listSessionSummaries, type SessionSummary } from "../session/events.js";
import { SessionRecorder } from "../session/recorder.js";
import { replaySession, type SessionReplay } from "../session/replay.js";
import { ensureAgentDirs, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SdkToolExecutionCoordinator } from "./sdkToolExecutionCoordinator.js";
import { buildSystemPrompt } from "./prompts.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentRuntimeContext, AgentSessionEvent } from "./types.js";
import { ContextMemory } from "./context/ContextMemory.js";
import { LocalMemory } from "./context/LocalMemory.js";
import { WorkspaceContext } from "./context/WorkspaceContext.js";
import type { ContextStatus } from "./context/types.js";
import { createSdkTelemetry } from "../observability/telemetry.js";
import { createSessionUsage, formatUsageSummary, summarizeUsage, type UsageModelInfo } from "../observability/usage.js";
import type { SessionUsage } from "../session/metadata.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  config: AgentConfig;
  model?: LanguageModel;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  recorder: SessionRecorder;
  modelManager?: ModelManager;
  skillPrompt?: string;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  mode?: AgentRunMode;
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
  private recorder: SessionRecorder;

  constructor(private readonly options: AgentSessionOptions) {
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
    const telemetry = (functionId: string) => createSdkTelemetry(options.config, options.workspaceRoot, functionId);
    const localMemory = options.config.context.memory.enabled
      ? new LocalMemory(options.workspaceRoot, getModel, onUsage, telemetry)
      : undefined;
    this.contextMemory = new ContextMemory(
      getModel,
      workspace,
      localMemory,
      options.config.context.maxInputTokens,
      options.config.context.instructionsMaxBytes,
      onUsage,
      telemetry
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
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) throw new Error("Vercel AI SDK model is not configured.");
    const settings = this.options.modelManager?.getModelSettings();
    const usageBeforePreparation = this.usageRecords.length;
    const mode = runOptions.mode ?? "chat";
    const messages = await this.contextMemory.prepareTurn(input, buildSystemPrompt(mode === "plan" ? "plan" : "qa", this.options.skillPrompt));
    const preparationUsage = this.usageRecords.slice(usageBeforePreparation);
    const permissionManager = this.options.permissionManager;
    const stepContext = { assistantContent: "", reasoningContent: "" };
    const queue = createSessionEventQueue();
    const runtime = this.runtimeContext(runOptions);
    const allowedToolNames = mode === "plan"
      ? new Set(this.options.toolRegistry.list().filter((tool) => tool.risk === "read").map((tool) => tool.name))
      : undefined;
    const coordinator = new SdkToolExecutionCoordinator(runtime, permissionManager, queue.push, () => ({ ...stepContext }), allowedToolNames);
    const agentSettings = {
      model,
      tools: coordinator.createTools(),
      allowSystemInMessages: true,
      stopWhen: stepCountIs(8),
      maxRetries: 0,
      providerOptions: settings?.providerOptions,
      reasoning: settings?.reasoning,
      timeout: settings?.timeoutMs,
      maxOutputTokens: settings?.maxOutputTokens,
      telemetry: createSdkTelemetry(this.options.config, this.options.workspaceRoot, "biny.agent"),
      // ToolLoopAgent forwards unknown stream options to streamText at runtime;
      // suppress its console.error default so Ink remains the only output sink.
      onError: () => undefined
    } as ToolLoopAgentSettings<never, ToolSet> & { onError: () => undefined };
    const agent = new ToolLoopAgent<never, ToolSet>(agentSettings);

    this.recorder.record({ type: "user_message", content: input, contextUsage: this.contextMemory.getBudget(), contextState: this.contextMemory.persistedState(), preparationUsage });
    yield { type: "status", status: "thinking" };

    let result: Awaited<ReturnType<typeof agent.stream>>;
    try {
      result = await agent.stream({ messages, abortSignal: runOptions.abortSignal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recorder.record({ type: "error", message });
      yield { type: "error", message };
      yield { type: "status", status: "error" };
      yield { type: "done", content: "" };
      return;
    }

    let streamError: unknown;
    const streamTask = (async (): Promise<void> => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "start-step") {
            stepContext.assistantContent = "";
            stepContext.reasoningContent = "";
          } else if (part.type === "text-delta") {
            stepContext.assistantContent += part.text;
          } else if (part.type === "reasoning-delta") {
            stepContext.reasoningContent += part.text;
          } else if (part.type === "error") {
            streamError = part.error;
          }
          if (part.type === "tool-call" && part.invalid) {
            await coordinator.handleInvalidToolCall(part.toolName, part.toolCallId, part.input, runOptions.abortSignal);
          }
          queue.push({ type: "sdk", part: part as TextStreamPart<ToolSet> });
        }
      } catch (error) {
        streamError = error;
        queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        queue.close();
      }
    })();

    for await (const event of queue) yield event;
    await streamTask;

    try {
      const [content, reasoningContent, responseMessages, usage, finalStep] = await Promise.all([
        result.text,
        result.reasoningText,
        result.responseMessages,
        result.usage,
        result.finalStep
      ]);
      this.contextMemory.recordProviderUsage(finalStep.usage.inputTokens !== undefined ? finalStep.usage : usage);
      const nextMessages = [...messages, ...responseMessages];
      this.contextMemory.replaceHistory(nextMessages);
      const usageRecord = this.recordModelUsage(usage, "agent");
      this.recorder.record({
        type: "assistant_message",
        content,
        reasoningContent: reasoningContent ?? undefined,
        usage: usageRecord,
        contextState: this.contextMemory.snapshot()
      });
      yield { type: "status", status: "completed" };
      yield { type: "done", content, usage: usageRecord };
    } catch (error) {
      const failure = streamError ?? error;
      const message = failure instanceof Error ? failure.message : String(failure);
      this.recorder.record({ type: "error", message });
      yield { type: "error", message };
      yield { type: "status", status: "error" };
      yield { type: "done", content: "" };
    }
  }

  async runTask(input: string, runOptions: AgentRunOptions = {}): Promise<string> {
    let output = "";
    for await (const event of this.run(input, runOptions)) {
      if (event.type === "done") output = event.content;
    }
    return output;
  }

  async createPlan(task: string, onDelta?: (delta: string) => void, abortSignal?: AbortSignal): Promise<string> {
    const userContent = `plan: ${task}`;
    const usageBeforePreparation = this.usageRecords.length;
    const messages = await this.contextMemory.prepareTurn(task, buildSystemPrompt("oneShotPlan", this.options.skillPrompt));
    const preparationUsage = this.usageRecords.slice(usageBeforePreparation);
    this.recorder.record({ type: "user_message", content: userContent, contextUsage: this.contextMemory.getBudget(), contextState: this.contextMemory.persistedState(), preparationUsage });

    try {
      const model = this.options.modelManager?.getModel() ?? this.options.model;
      if (!model) throw new Error("Vercel AI SDK model is not configured.");
      const result = streamText({
        model,
        messages,
        allowSystemInMessages: true,
        abortSignal,
        maxRetries: 0,
        providerOptions: this.options.modelManager?.getModelSettings().providerOptions,
        reasoning: this.options.modelManager?.getModelSettings().reasoning,
        timeout: this.options.modelManager?.getModelSettings().timeoutMs,
        maxOutputTokens: this.options.modelManager?.getModelSettings().maxOutputTokens,
        telemetry: createSdkTelemetry(this.options.config, this.options.workspaceRoot, "biny.plan"),
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
      return output;
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  async resume(session: string | undefined): Promise<ResumedAgentSession> {
    await ensureAgentDirs(this.options.workspaceRoot);
    const filePath = await resolveSessionFile(this.options.workspaceRoot, session);
    const replay = await replaySession(filePath);
    const previousRecorder = this.recorder;
    await previousRecorder.close();
    if (!previousRecorder.hasRecordedEvents()) await fs.rm(previousRecorder.filePath, { force: true });

    this.recorder = new SessionRecorder(this.options.workspaceRoot, sessionIdFromFile(filePath));
    this.recorder.restoreToolCallSequence(maxToolCallSequence(replay.events));
    this.options.permissionManager.resetSession();
    this.usageRecords = [...replay.usage];
    this.contextMemory.restore(replay.messages, replay.contextState ?? replay.contextUsage);
    return { ...replay, filePath, sessionId: this.recorder.sessionId };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await listSessionSummaries(this.options.workspaceRoot);
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

  observeModelUsage(usage: LanguageModelUsage, operation: "agent" | "plan" | "compaction" | "memory" | "subagent"): void {
    this.recordModelUsage(usage, operation);
  }

  async compactConversation(hint?: string): Promise<string> {
    const usageBeforeCompaction = this.usageRecords.length;
    const result = await this.contextMemory.compact(hint);
    const compactionUsage = this.usageRecords.slice(usageBeforeCompaction).at(-1);
    this.recorder.record({
      type: "assistant_message",
      content: "",
      reasoningContent: undefined,
      usage: compactionUsage,
      contextState: this.contextMemory.snapshot()
    });
    return this.contextMemory.formatCompaction(result);
  }

  listModels(): ModelChoice[] {
    return this.options.modelManager?.listModels() ?? listModelChoices(this.options.config);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
    return await this.options.modelManager.switchModel(alias, thinking);
  }

  getInfo(): AgentSessionInfo {
    const model = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    return {
      workspaceRoot: this.options.workspaceRoot,
      sessionId: this.recorder.sessionId,
      sessionFile: this.recorder.filePath,
      ...model
    };
  }

  getPermissionMode(): PermissionMode {
    return this.options.permissionManager.getStatus().mode;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.options.permissionManager.setMode(mode);
    this.options.config.permission.mode = mode;
    await saveConfig(this.options.workspaceRoot, this.options.config);
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    const previousMode = this.options.permissionManager.getStatus().mode;
    const output = runPermissionCommand(this.options.permissionManager, args);
    if (this.options.permissionManager.getStatus().mode !== previousMode) {
      this.options.config.permission.mode = this.options.permissionManager.getStatus().mode;
      await saveConfig(this.options.workspaceRoot, this.options.config);
    }
    return output;
  }

  recordError(error: unknown): void {
    this.recorder.record({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  async close(): Promise<void> {
    await this.contextMemory.flush();
    await this.recorder.close();
  }

  private recordModelUsage(usage: LanguageModelUsage, operation: "agent" | "plan" | "compaction" | "memory" | "subagent"): SessionUsage {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    const info = this.options.modelManager?.getInfo() ?? modelRuntimeInfo(this.options.config);
    const resolved = this.options.config.models[info.modelAlias];
    const modelInfo: UsageModelInfo = {
      modelAlias: info.modelAlias,
      provider: info.provider,
      model: model ? modelIdentifier(model) : info.modelLabel,
      pricing: resolved?.pricing
    };
    const record = createSessionUsage(usage, operation, modelInfo);
    this.usageRecords.push(record);
    return record;
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
      abortSignal: runOptions.abortSignal
    };
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

interface SessionEventQueue extends AsyncIterable<AgentSessionEvent> {
  push(event: AgentSessionEvent): void;
  close(): void;
}

function createSessionEventQueue(): SessionEventQueue {
  const values: AgentSessionEvent[] = [];
  const waiters: Array<(result: IteratorResult<AgentSessionEvent>) => void> = [];
  let closed = false;
  return {
    push(event) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else values.push(event);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()?.({ value: undefined as unknown as AgentSessionEvent, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (closed) return Promise.resolve({ value: undefined as unknown as AgentSessionEvent, done: true });
          return new Promise<IteratorResult<AgentSessionEvent>>((resolve) => waiters.push(resolve));
        }
      };
    }
  };
}
