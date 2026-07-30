import { promises as fs } from "node:fs";
import path from "node:path";
import type { LanguageModel, LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from "ai";
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
import { SessionRecorder, type ReasoningBlock } from "../session/recorder.js";
import { replaySessionEvents, type SessionReplay } from "../session/replay.js";
import { TurnStore, type InterruptedTurn } from "../session/turnStore.js";
import { ensureAgentDirs, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgentLoop, type AgentLoopConfig, type AgentLoopResult } from "./agentLoop.js";
import { SdkToolExecutionCoordinator, type AgentStepContext } from "./sdkToolExecutionCoordinator.js";
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
import { runMemoryCommand } from "./context/memoryCommands.js";
import { WorkspaceContext } from "./context/WorkspaceContext.js";
import type { ContextStatus } from "./context/types.js";
import { createSdkTelemetry } from "../observability/telemetry.js";
import { createSessionUsage, formatUsageSummary, sumSessionUsage, summarizeUsage, type UsageModelInfo } from "../observability/usage.js";
import type { SessionUsage, UsageSummary } from "../session/metadata.js";
import { AsyncEventQueue } from "../runtime/AsyncEventQueue.js";
import { defaultModelContextWindow, modelContextBudget } from "../ai/capabilities.js";
import { modelCapabilities } from "../ai/capabilities.js";
import { createLanguageModelForConfig } from "../llm/factory.js";
import { readAttachment, type AgentAttachment } from "../attachments/store.js";
import type { AttachmentReference } from "../attachments/store.js";

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
  skillPrompt?: string;
  /** 具名子代理定义元数据段（delegate_task 可用的 agent 列表）。 */
  subagentPrompt?: string;
  skillPaths?: string[];
  /** MCP 服务器 initialize 返回的 instructions 汇总；重连后会变化，因此每回合实时读取。 */
  mcpPrompt?: () => string;
  /** 模型自己维护的计划清单；每回合实时读取，历史压缩不会让它丢失。 */
  todoPrompt?: () => string | undefined;
  /** 回合内首次改动工作区前建快照，供 /undo 回退；不在 git 仓库时省略。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  /** 会话恢复时按虚拟路径重新读取项目级附件。 */
  attachmentRoot?: string;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  mode?: AgentRunMode;
  /** Per-attempt cap, bounded by the configured circuit breaker. */
  maxSteps?: number;
  /** A task harness may defer success memory until external acceptance checks pass. */
  deferSuccessfulMemory?: boolean;
  /** Model-visible prompt when the public user input must remain separate. */
  modelInput?: string;
  /**
   * 从已有 context 直接续跑，跳过上下文组装，也不再记一条用户消息。
   * 对齐 pi 的 `agentLoopContinue`：续跑的是同一个回合，不是新的一轮对话。
   */
  continueFrom?: ModelMessage[];
  /** Public session message when the model input is an internal task-attempt prompt. */
  sessionUserMessage?: string;
  /** Whether this attempt should append a user message to the visible session transcript. */
  recordSessionUserMessage?: boolean;
  attachments?: AgentAttachment[];
}

export type AgentPromptOptions = Pick<
  AgentRunOptions,
  "abortSignal" | "confirmPermission" | "mode" | "attachments"
>;

export type AgentAttemptOptions = Omit<AgentRunOptions, "mode">;

export type { AgentAttachment } from "../attachments/store.js";

export interface AgentSessionInfo {
  workspaceRoot: string;
  sessionId: string;
  sessionFile: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  modelAlias: string;
  thinking: ThinkingSelection;
  contextWindow?: number;
  /** 单轮允许注入的输入 token 预算；`getInfo()` 一直带着它，界面用它算上下文用量。 */
  maxInputTokens?: number;
  skills?: string[];
}

/** 普通交互统一走 chat；plan 只改变工具策略。durable execution 不属于交互 mode。 */
export type AgentRunMode = "chat" | "plan";
export type InteractiveAgentRunMode = AgentRunMode;

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
  private readonly localMemory: LocalMemory | undefined;
  private usageRecords: SessionUsage[] = [];
  private unpersistedRelatedUsage: SessionUsage[] = [];
  private recorder: SessionRecorder;
  private turnStore: TurnStore;
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
    const memoryConfig = options.config.context.memory;
    const memoryModelAlias = memoryConfig.model;
    // 记忆抽取/整理可以指定专用小模型；未配置时跟随会话模型。懒创建并缓存，避免每次写记忆都重建 adapter。
    let memoryModel: LanguageModel | undefined;
    const getMemoryModel = memoryModelAlias
      ? (): LanguageModel => (memoryModel ??= createLanguageModelForConfig(options.config, memoryModelAlias))
      : getModel;
    this.localMemory = memoryConfig.enabled
      ? new LocalMemory(persistenceRoot, getMemoryModel, onUsage, telemetry, () => options.modelManager?.getModelSettings().maxRetries ?? 0, memoryConfig.maxRecalled)
      : undefined;
    this.contextMemory = new ContextMemory(
      getModel,
      workspace,
      this.localMemory,
      options.config.context.maxInputTokens ?? defaultModelContextWindow,
      options.config.context.instructionsMaxBytes,
      onUsage,
      telemetry,
      () => {
        const activeModel = options.config.models[options.config.defaultModel];
        if (!activeModel) {
          // 模型别名缺失时只能退回保守窗口，真实预算永远以模型自身声明为准。
          const fallback = options.config.context.maxInputTokens ?? defaultModelContextWindow;
          return {
            modelAlias: options.config.defaultModel,
            contextWindow: fallback,
            maxInputTokens: fallback,
            maxOutputTokens: undefined
          };
        }
        return modelContextBudget(activeModel, options.config.context.maxInputTokens, options.config.defaultModel);
      },
      () => options.modelManager?.getModelSettings().maxRetries ?? 0
    );
    this.recorder = options.recorder;
    this.turnStore = new TurnStore(this.persistenceRoot(), options.recorder.sessionId);
  }

  async initialize(): Promise<void> {
    await this.contextMemory.initialize();
  }

  /** 技能元数据、具名子代理清单与 MCP instructions 共同构成 system prompt 的扩展段。 */
  private extensionPrompt(): string | undefined {
    const sections = [
      this.options.skillPrompt?.trim(),
      this.options.subagentPrompt?.trim(),
      this.options.mcpPrompt?.().trim(),
      this.options.todoPrompt?.()?.trim()
    ].filter(Boolean);
    return sections.length ? sections.join("\n\n") : undefined;
  }

  /** 上次被打断、尚未收尾的回合；没有则为 undefined。 */
  async interruptedTurn(): Promise<InterruptedTurn | undefined> {
    return await this.turnStore.load();
  }

  /**
   * 从被打断的地方继续同一个回合。
   *
   * 用的是断点时的完整 context，所以已完成步骤的工具结果都还在，模型不需要重跑它们。
   * 没有可续跑的状态时抛错而不是静默开一个新回合 —— 后者会让用户以为续上了，其实是重来。
   */
  async *continueInterruptedTurn(runOptions: AgentRunOptions = {}): AsyncGenerator<AgentSessionEvent> {
    const turn = await this.turnStore.load();
    if (!turn) throw new Error("There is no interrupted turn to continue.");
    const turnLimit = runOptions.maxSteps ?? this.options.config.agent.maxSteps;
    const remainingSteps = turnLimit - turn.completedSteps;
    if (remainingSteps < 1) {
      await this.turnStore.clear().catch(() => undefined);
      throw new Error(
        `The interrupted turn already reached its ${String(turnLimit)}-step limit. `
        + "Send a new user message to start another turn."
      );
    }
    yield* this.runTurn(turn.prompt, {
      ...runOptions,
      maxSteps: remainingSteps,
      continueFrom: turn.messages,
      recordSessionUserMessage: false,
      completedStepsBeforeRun: turn.completedSteps
    });
  }

  /** 持久记忆存储句柄；记忆工具与 /memory 命令共用（禁用时为 undefined）。 */
  getLocalMemory(): LocalMemory | undefined {
    return this.localMemory;
  }

  async runMemoryCommand(args: string[]): Promise<string> {
    return await runMemoryCommand(this.localMemory, args);
  }

  /** Desktop/TUI 的公开交互入口，只接受 chat / plan 策略。 */
  async *prompt(input: string, options: AgentPromptOptions = {}): AsyncGenerator<AgentSessionEvent> {
    yield* this.runTurn(input, options);
  }

  /** Durable task harness 的单次有界尝试；不暴露为交互 mode。 */
  async *runAttempt(input: string, options: AgentAttemptOptions = {}): AsyncGenerator<AgentSessionEvent> {
    yield* this.runTurn(input, { ...options, mode: "chat" });
  }

  private async *runTurn(
    input: string,
    runOptions: AgentRunOptions & { completedStepsBeforeRun?: number } = {}
  ): AsyncGenerator<AgentSessionEvent> {
    const release = this.beginOperation("agent turn");
    const turnController = new AbortController();
    const abortSignal = runOptions.abortSignal
      ? AbortSignal.any([runOptions.abortSignal, turnController.signal])
      : turnController.signal;
    const effectiveRunOptions: AgentRunOptions = { ...runOptions, abortSignal };
    const modelInput = runOptions.modelInput ?? input;
    const continuing = Boolean(runOptions.continueFrom?.length);
    const completedStepsBeforeRun = continuing ? runOptions.completedStepsBeforeRun ?? 0 : 0;
    if (!Number.isSafeInteger(completedStepsBeforeRun) || completedStepsBeforeRun < 0) {
      throw new RangeError("Completed turn steps must be a non-negative safe integer.");
    }
    const usageBeforePreparation = this.usageRecords.length;
    let userMessageRecorded = false;
    const recordUserMessage = (): void => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      if (runOptions.recordSessionUserMessage === false) return;
      this.recorder.record({
        type: "user_message",
        content: runOptions.sessionUserMessage ?? input,
        attachments: sessionAttachments(runOptions.attachments),
        skills: this.options.skillPaths,
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        preparationUsage: this.usageRecords.slice(usageBeforePreparation)
      });
    };
    let streamTask: Promise<void> | undefined;
    try {
    // 新根输入明确放弃旧断点；否则它在首个新 step 落盘前崩溃时，/continue 会错误复活上一回合。
    if (!continuing) await this.turnStore.clear().catch(() => undefined);
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = abortedTurn("Current turn interrupted before execution.", completedStepsBeforeRun);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "aborted" };
      yield doneEvent(outcome);
      return;
    }
    try {
      await this.options.modelManager?.preparePrompt(abortSignal);
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? abortedTurn("Current turn interrupted during model preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, "provider_error");
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "aborted" ? "aborted" : "error" };
      yield doneEvent(outcome);
      return;
    }
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) {
      recordUserMessage();
      const outcome = failedTurn("Vercel AI SDK model is not configured.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }
    const settings = this.options.modelManager?.getModelSettings();
    const mode = runOptions.mode ?? "chat";
    let messages: ModelMessage[];
    if (runOptions.continueFrom?.length) {
      // 续跑用的是被打断那一刻的 context，重新组装会丢掉已完成步骤的工具结果。
      messages = [...runOptions.continueFrom];
      userMessageRecorded = true;
    } else {
    // 先把用户原始输入（以及附件引用）写进 JSONL，再组装上下文或检查模型能力。
    // 这样即使模型不支持图片、上下文构建失败或进程随后中断，恢复会话时仍能看到这次输入。
    recordUserMessage();
    try {
      const systemPrompt = buildSystemPrompt(
        mode === "plan" ? "plan" : "qa",
        this.extensionPrompt(),
        this.options.toolRegistry.list().map((tool) => tool.name)
      );
      messages = await this.contextMemory.prepareTurn(
        modelInput,
        systemPrompt,
        abortSignal,
        this.supportedAttachments(runOptions.attachments)
      );
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? abortedTurn("Current turn interrupted during context preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(outcome.error);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "aborted" ? "aborted" : "error" };
      yield doneEvent(outcome);
      return;
    }
    }
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = abortedTurn("Current turn interrupted during context preparation.", completedStepsBeforeRun);
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
    const stepContext: AgentStepContext = { assistantContent: "", reasoningContent: "", reasoningProviderOptions: undefined, reasoningBlocks: [] };
    const queue = new AsyncEventQueue<AgentSessionEvent>();
    const runtime = this.runtimeContext(effectiveRunOptions);
    const allowedToolNames = mode === "plan"
      ? new Set(this.options.toolRegistry.list().filter((tool) => tool.risk === "read").map((tool) => tool.name))
      : undefined;
    let reasoningActive = false;
    const emitUpdate = (event: AgentSessionEvent): void => {
      if (
        reasoningActive
        && (event.type === "assistant.delta" || event.type === "assistant.completed" || event.type === "tool.started")
      ) {
        queue.push({ type: "reasoning.completed" });
        reasoningActive = false;
      }
      if (event.type === "reasoning.started") {
        if (reasoningActive) return;
        reasoningActive = true;
      } else if (event.type === "reasoning.completed") {
        reasoningActive = false;
      }
      queue.push(event);
    };
    const coordinator = new SdkToolExecutionCoordinator(
      runtime,
      permissionManager,
      emitUpdate,
      () => ({ ...stepContext }),
      allowedToolNames
    );
    const loopConfig: AgentLoopConfig = {
      model,
      tools: coordinator.createTools(),
      maxSteps,
      streamOptions: {
        maxRetries: settings?.maxRetries ?? 0,
        providerOptions: settings?.providerOptions,
        reasoning: settings?.reasoning,
        timeout: settings?.timeoutMs,
        maxOutputTokens: settings?.maxOutputTokens,
        telemetry: createSdkTelemetry(this.options.config, this.persistenceRoot(), "biny.agent")
      },
      // 回合内上下文治理的落点。剪枝失败不该打断这一步，退回原 messages 让 provider 自己报错。
      transformContext: async (stepMessages) => {
        try {
          return this.contextMemory.pruneToolResultsForStep(stepMessages);
        } catch {
          return stepMessages;
        }
      },
      onPart: handlePart,
      onStepEnd: async (step) => {
        // 每步各自是一次 provider 请求，用量按步记录而不是等回合结束一次性归并。
        stepUsageRecords.push(this.recordModelUsage(step.usage, mode === "plan" ? "plan" : "agent"));
        if (step.usage.inputTokens !== undefined) this.contextMemory.recordProviderUsage(step.usage);
        const completedSteps = completedStepsBeforeRun + step.index + 1;
        if (step.finishReason === "tool-calls" && step.index + 1 < maxSteps) {
          // 只有 Agent Loop 本来还会进入下一步时才保留断点。正常完成、输出截断和 step-limit
          // 都是已经返回给用户的终态，不能被 /continue 误认成异常中断。
          await this.turnStore.save(runOptions.sessionUserMessage ?? input, step.messages, completedSteps)
            .catch(() => undefined);
        } else {
          await this.turnStore.clear().catch(() => undefined);
        }
      }
    };
    const stepUsageRecords: SessionUsage[] = [];

    recordUserMessage();
    yield { type: "status", status: "thinking" };

    let loopResult: AgentLoopResult | undefined;
    let streamError: unknown;
    let observedSteps = 0;
    const invalidToolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }> = [];
    let duplicateToolCallError: Error | undefined;
    let streamFailureReported = false;
    // 整个回合的 reasoning 展示文本；stepContext.reasoningContent 每步会清空。
    let turnReasoningContent = "";
    // 一步里可能有多个 reasoning block，每个各自签名，必须分开保留而不是拼成一段。
    const reasoningBlockIds = new Map<string, ReasoningBlock>();
    const reasoningBlock = (id: string): ReasoningBlock => {
      const existing = reasoningBlockIds.get(id);
      if (existing) return existing;
      const created: ReasoningBlock = { text: "" };
      reasoningBlockIds.set(id, created);
      (stepContext.reasoningBlocks ??= []).push(created);
      return created;
    };
    function handlePart(part: TextStreamPart<ToolSet>): void {
      if (part.type === "start-step") {
        const phase = observedSteps === 0 ? "initial" : "continuing";
        observedSteps += 1;
        stepContext.assistantContent = "";
        stepContext.reasoningContent = "";
        stepContext.reasoningProviderOptions = undefined;
        stepContext.reasoningBlocks = [];
        reasoningBlockIds.clear();
        emitUpdate({ type: "reasoning.started", phase });
      } else if (part.type === "text-delta") {
        stepContext.assistantContent += part.text;
        emitUpdate({ type: "assistant.delta", content: part.text });
      } else if (part.type === "reasoning-delta") {
        stepContext.reasoningContent += part.text;
        turnReasoningContent += part.text;
        stepContext.reasoningProviderOptions = part.providerMetadata ?? stepContext.reasoningProviderOptions;
        const block = reasoningBlock(part.id);
        block.text += part.text;
        if (part.providerMetadata) block.providerOptions = part.providerMetadata;
        emitUpdate({ type: "reasoning.delta", content: part.text });
      } else if (part.type === "reasoning-start" || part.type === "reasoning-end") {
        stepContext.reasoningProviderOptions = part.providerMetadata ?? stepContext.reasoningProviderOptions;
        const block = reasoningBlock(part.id);
        if (part.providerMetadata) block.providerOptions = part.providerMetadata;
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
        if (part.invalid) {
          invalidToolCalls.push({
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            input: part.input
          });
        }
      }
    }
    streamTask = (async (): Promise<void> => {
      try {
        loopResult = await runAgentLoop(messages, loopConfig, abortSignal);
      } catch (error) {
        // 重复 tool call 这类情况已经推过 fatal error 并主动 abort 了；循环随后抛出的
        // 中断异常是同一件事的后果，不能再报一次。首个原因也要保留，不被中断异常覆盖。
        streamError ??= error;
        if (!streamFailureReported) {
          streamFailureReported = true;
          queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (!duplicateToolCallError) {
          await Promise.all(invalidToolCalls.map(async (call) => {
            await coordinator.handleInvalidToolCall(call.toolName, call.toolCallId, call.input, abortSignal);
          }));
        }
        await coordinator.waitForIdle();
        if (reasoningActive) emitUpdate({ type: "reasoning.completed" });
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
      // A provider can surface an error as a fullStream part while still
      // producing partial output. Do not let a partial answer commit history or
      // look like a successful turn.
      if (streamError !== undefined) throw streamError;
      if (!loopResult) throw new Error("Agent loop ended without a result.");
      const content = loopResult.text;
      const steps = loopResult.steps;
      // 循环自己拼 context：每步的 responseMessages 已经按序并入，剪枝后的 messages 也
      // 在里面，所以直接用循环的最终结果，而不是 [初始 messages + 全部响应]。
      this.contextMemory.replaceHistory(loopResult.messages);
      // 每步的用量已在 onStepEnd 逐条记账；回合级记录用它们的合计，避免重复计费。
      const usageRecord = sumSessionUsage(stepUsageRecords);
      this.recorder.record({
        type: "assistant_message",
        content,
        reasoningContent: turnReasoningContent || undefined,
        // reasoningContent 是整个回合的展示文本；可回放的部分只有最后一步这些带签名的块。
        reasoningProviderOptions: stepContext.reasoningProviderOptions,
        reasoningBlocks: stepContext.reasoningBlocks,
        usage: usageRecord,
        relatedUsage: this.takeRelatedUsage(),
        contextState: this.contextMemory.snapshot()
      });
      const outcome = finishedTurn(
        content,
        loopResult.finishReason,
        completedStepsBeforeRun + steps.length,
        completedStepsBeforeRun + maxSteps,
        usageRecord
      );
      if (content && (outcome.status === "completed" || outcome.status === "incomplete")) {
        yield { type: "assistant.completed", content };
      }
      if (outcome.status === "completed") {
        if (!runOptions.deferSuccessfulMemory) {
          this.rememberSuccessfulTask(runOptions.sessionUserMessage ?? input, content);
        }
        yield { type: "status", status: "completed" };
      } else if (outcome.status === "incomplete") {
        yield { type: "status", status: "incomplete" };
      } else {
        this.recordError(outcome.error ?? `Agent stopped with finish reason ${outcome.finishReason ?? "unknown"}.`);
        yield { type: "error", message: outcome.error ?? "Agent run failed." };
        yield { type: "status", status: "error" };
      }
      await this.turnStore.clear().catch(() => undefined);
      yield doneEvent(outcome);
    } catch (error) {
      const failure = streamError ?? error;
      const message = errorMessage(failure);
      const outcome = runOptions.abortSignal?.aborted
        ? abortedTurn(message || "Current turn interrupted.", completedStepsBeforeRun + observedSteps)
        : failedTurn(message, completedStepsBeforeRun + observedSteps, isTimeoutFailure(failure) ? "timeout" : "provider_error");
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
      for await (const event of this.runTurn(input, runOptions)) {
        if (event.type === "done") outcome = event.outcome;
      }
    } catch (error) {
      const message = errorMessage(error);
      this.recordError(message);
      return failedTurn(message, 0, isTimeoutFailure(error) ? "timeout" : "provider_error");
    }
    return outcome ?? failedTurn("Agent stream ended without a terminal result.", 0);
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
      const messages = await this.rehydrateSessionAttachments(replay.messages, replay.events);
      this.contextMemory.restore(messages, replay.contextState ?? replay.contextUsage);
      this.recorder = replacementRecorder;
      this.turnStore = new TurnStore(this.persistenceRoot(), replacementRecorder.sessionId);
      return { ...replay, messages, filePath, sessionId: replacementRecorder.sessionId };
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

  /** 本会话累计用量的快照；evals 和宿主用它做度量，拿到的是副本不是内部数组。 */
  usageSummary(): UsageSummary {
    return summarizeUsage(this.usageRecords);
  }

  usageReport(): string {
    return formatUsageSummary(summarizeUsage(this.usageRecords));
  }

  /** 当前激活模型不支持媒体时返回明确错误；输入本身已先写入会话，方便恢复和切换模型后重试。 */
  assertAttachmentsSupported(attachments: AgentAttachment[]): void {
    if (!attachments.length) return;
    const modelAlias = this.options.modelManager?.getInfo().modelAlias ?? this.options.config.defaultModel;
    const model = this.options.config.models[modelAlias];
    if (!model) throw new Error(`当前模型配置不存在：${modelAlias}`);
    const capabilities = modelCapabilities(model);
    const image = attachments.find((attachment) => attachment.mimeType.startsWith("image/"));
    if (image && !capabilities.vision) {
      throw new Error(`当前模型 ${modelAlias} 未声明 vision 能力，无法发送图片附件。请切换到支持图片的模型，或在模型配置中明确启用 capabilities.vision。`);
    }
    const audio = attachments.find((attachment) => attachment.mimeType.startsWith("audio/"));
    if (audio && !capabilities.audio) {
      throw new Error(`当前模型 ${modelAlias} 未声明 audio 能力，无法发送音频附件。请切换到支持音频的模型，或在模型配置中明确启用 capabilities.audio。`);
    }
  }

  observeModelUsage(
    usage: LanguageModelUsage,
    operation: "agent" | "plan" | "compaction" | "memory" | "subagent",
    modelAlias?: string
  ): void {
    this.recordModelUsage(usage, operation, modelAlias);
  }

  /** 自动沉淀受 context.memory.autoRemember 控制；显式 save_memory 工具不受影响。 */
  rememberSuccessfulTask(task: string, answer: string): void {
    if (!this.options.config.context.memory.autoRemember) return;
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

  async refreshModelCatalog(providerAlias?: string): Promise<ModelChoice[]> {
    const release = this.beginOperation("model catalog refresh");
    try {
      if (!this.options.modelManager) throw new Error("This agent runtime does not support model switching.");
      await this.options.modelManager.refreshModelCatalog(providerAlias);
      return this.options.modelManager.listModels();
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
      await this.savePermissionMode(mode);
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
      const nextMode = this.options.permissionManager.getStatus().mode;
      if (nextMode !== previousMode) {
        this.options.config.permission.mode = nextMode;
        try {
          await this.savePermissionMode(nextMode);
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
      createCheckpoint: this.options.createCheckpoint,
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

  /**
   * 只把权限模式写回配置文件。
   *
   * 内存里的 config 是运行时创建时读到的快照，之后可能已经落后于磁盘（桌面端多个项目共用
   * 同一份配置，别的运行时切模型、刷新 OAuth token 都会改盘上的内容）。整份写回会把这些改动
   * 覆盖掉——表现出来就是「改一次权限模式，模型被切回旧的默认模型」。因此这里读盘后只改
   * `permission.mode` 再保存。
   */
  private async savePermissionMode(mode: PermissionMode): Promise<void> {
    const store = this.configStore();
    const persisted = await store.load(this.options.workspaceRoot);
    persisted.permission.mode = mode;
    await store.save(persisted, this.options.workspaceRoot);
  }

  private supportedAttachments(attachments: AgentAttachment[] | undefined): AgentAttachment[] {
    const native = attachments?.filter((attachment) => Boolean(attachment.data)) ?? [];
    this.assertAttachmentsSupported(native);
    return native;
  }

  private async rehydrateSessionAttachments(messages: ModelMessage[], events: SessionReplay["events"]): Promise<ModelMessage[]> {
    if (!this.options.attachmentRoot) return messages;
    const userEvents = events.filter((event): event is Extract<typeof event, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly);
    let userIndex = 0;
    const hydrated: ModelMessage[] = [];
    for (const message of messages) {
      if (message.role !== "user") {
        hydrated.push(message);
        continue;
      }
      const event = userEvents[userIndex];
      userIndex += 1;
      const attachments = await Promise.all((event?.attachments ?? []).map(async (attachment) => await readAttachment(this.options.attachmentRoot!, attachment)));
      const files = attachments.filter((attachment): attachment is AgentAttachment => attachment !== undefined);
      this.assertAttachmentsSupported(files);
      if (!files.length || typeof message.content !== "string") {
        hydrated.push(message);
        continue;
      }
      hydrated.push({
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...files.map((attachment) => ({
            type: "file" as const,
            data: { type: "data" as const, data: attachment.data },
            mediaType: attachment.mimeType,
            filename: attachment.name
          }))
        ]
      });
    }
    return hydrated;
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

function sessionAttachments(attachments: AgentAttachment[] | undefined): AttachmentReference[] | undefined {
  const references = attachments
    ?.filter((attachment) => Boolean(attachment.path))
    .map(({ name, mimeType, path: virtualPath, size }) => ({ name, mimeType, path: virtualPath!, size }));
  return references?.length ? references : undefined;
}
