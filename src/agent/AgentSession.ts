import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "./core/modelMessage.js";
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
import {
  TurnStore,
  type InterruptedTurn,
  type InterruptedTurnTerminal
} from "../session/turnStore.js";
import { ensureAgentDirs, resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { agentLoopContinue } from "./core/agentLoop.js";
import type {
  AgentAssistantMessage,
  AgentModel,
  AgentContext,
  AgentMessage,
  AgentUserMessage,
  AgentUsage
} from "./core/types.js";
import { ToolExecutionCoordinator } from "./toolExecutionCoordinator.js";
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
import { recordNativeTelemetryEnd } from "../observability/telemetry.js";
import { createSessionUsage, formatUsageSummary, sumSessionUsage, summarizeUsage, type UsageModelInfo } from "../observability/usage.js";
import type { SessionUsage, UsageSummary } from "../session/metadata.js";
import { defaultModelContextWindow, modelContextBudget } from "../ai/capabilities.js";
import { modelCapabilities } from "../ai/capabilities.js";
import { createNativeModelForConfig } from "../llm/nativeFactory.js";
import type { NativeModelSettings } from "../llm/nativeFactory.js";
import { readAttachment, type AgentAttachment } from "../attachments/store.js";
import type { AttachmentReference } from "../attachments/store.js";
import { TodoStore } from "../session/todoStore.js";
import { CompletionStateStore } from "./completionState.js";
import {
  CompletionGate,
  RunFactsCollector,
  type CompletionDecision,
  type CompletionGateVerifier,
  type CompletionVerification,
  type ProcessFact,
  type RunFacts,
  type StructuredVerificationCheck,
  type VerificationFact
} from "./completionGate.js";
import { resolveRunBudget, type RunBudget } from "./runBudget.js";
import {
  deriveAgentVerificationPlan,
  type AgentVerificationFacts,
  type AgentVerificationPlan
} from "./verification.js";
import { AcceptanceVerifier, type ManagedProcessInspector } from "../harness/AcceptanceVerifier.js";
import {
  createControlledAcceptanceCommandExecutor,
  type AcceptanceCommandExecutor
} from "../harness/AcceptanceCommandExecutor.js";
import {
  captureWorkspaceState,
  diffWorkspaceStates,
  type WorkspaceStateSnapshot
} from "../harness/WorkspaceState.js";

export interface AgentSessionOptions {
  workspaceRoot: string;
  persistenceRoot?: string;
  configStore?: AgentConfigStore;
  config: AgentConfig;
  model?: AgentModel;
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
  /** Todo 真值源；Completion Gate 与 session resume 共用同一个实例。 */
  todoStore?: TodoStore;
  /** 模型声明的 blocked / verification 状态，只在当前根回合内有效。 */
  completionState?: CompletionStateStore;
  /** Completion Gate 检查本回合启动的受管进程。 */
  managedProcesses?: ManagedProcessInspector;
  /** 回合内首次改动工作区前建快照，供 /undo 回退；不在 git 仓库时省略。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  /** 会话恢复时按虚拟路径重新读取项目级附件。 */
  attachmentRoot?: string;
}

export interface AgentRunOptions {
  abortSignal?: AbortSignal;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  mode?: AgentRunMode;
  /** 本次调用可消费的硬 step 上限；普通根回合默认使用配置的 hardStepLimit。 */
  maxSteps?: number;
  /**
   * 从已有 context 直接续跑，跳过上下文组装，也不再记一条用户消息。
   * 对齐 pi 的 `agentLoopContinue`：续跑的是同一个回合，不是新的一轮对话。
   */
  continueFrom?: ModelMessage[];
  /** 续跑同一 Turn 时不重复追加公开用户消息。 */
  recordSessionUserMessage?: boolean;
  /** 宿主显式要求 Completion Gate 执行确定性验证；不从用户文本关键词推断。 */
  verificationRequired?: boolean;
  /** 宿主提供的结构化验证条件，会与模型通过 request_verification 声明的条件合并。 */
  verificationChecks?: StructuredVerificationCheck[];
  attachments?: AgentAttachment[];
}

export type AgentPromptOptions = Pick<
  AgentRunOptions,
  "abortSignal" | "confirmPermission" | "mode" | "verificationRequired" | "verificationChecks" | "attachments"
>;

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

/** 普通交互统一走 chat；plan 只改变工具策略。 */
export type AgentRunMode = "chat" | "plan";
export type InteractiveAgentRunMode = AgentRunMode;

export interface ResumedAgentSession extends SessionReplay {
  filePath: string;
  sessionId: string;
}

interface NativeTurnArgs {
  input: string;
  messages: ModelMessage[];
  runOptions: AgentRunOptions & {
    initialRunFacts?: RunFacts;
    previousTerminals?: InterruptedTurnTerminal[];
  };
  abortSignal: AbortSignal;
  mode: AgentRunMode;
  runBudget: RunBudget;
  completedStepsBeforeRun: number;
  workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined;
  captureWorkspaceBaseline: () => Promise<void>;
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
    const getModel = (): AgentModel => {
      const model = options.modelManager?.getNativeModel() ?? options.model;
      if (!model) throw new Error("Agent model is not configured.");
      return model;
    };
    const onUsage = async (usage: AgentUsage, operation: "agent" | "plan" | "compaction" | "memory" | "subagent"): Promise<void> => {
      this.recordModelUsage(usage, operation);
    };
    const memoryConfig = options.config.context.memory;
    const memoryModelAlias = memoryConfig.model;
    // 记忆抽取/整理可以指定专用小模型；未配置时跟随会话模型。懒创建并缓存，避免每次写记忆都重建 adapter。
    let memoryModel: AgentModel | undefined;
    const getMemoryModel = memoryModelAlias
      ? (): AgentModel => (memoryModel ??= createNativeModelForConfig(options.config, memoryModelAlias))
      : getModel;
    this.localMemory = memoryConfig.enabled
      ? new LocalMemory(persistenceRoot, getMemoryModel, onUsage, memoryConfig.maxRecalled)
      : undefined;
    this.contextMemory = new ContextMemory(
      getModel,
      workspace,
      this.localMemory,
      options.config.context.maxInputTokens ?? defaultModelContextWindow,
      options.config.context.instructionsMaxBytes,
      onUsage,
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
      }
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
      (this.options.todoStore?.promptSection() ?? this.options.todoPrompt?.())?.trim()
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
    if (
      turn.terminal?.status === "blocked"
      && (turn.terminal.blockedReason === "missing_user_input"
        || turn.terminal.blockedReason === "unsafe_action_required")
    ) {
      throw new Error(
        turn.terminal.requiredAction
          ? `This blocked turn requires a new user message: ${turn.terminal.requiredAction}`
          : "This blocked turn requires a new user message before it can continue."
      );
    }
    const turnLimit = runOptions.maxSteps ?? resolveRunBudget(this.options.config.agent).hardStepLimit;
    const remainingSteps = turnLimit - turn.completedSteps;
    if (remainingSteps < 1) {
      await this.turnStore.clear().catch(() => undefined);
      throw new Error(
        `The interrupted turn already reached its ${String(turnLimit)}-step limit. `
        + "Send a new user message to start another turn."
      );
    }
    if (turn.terminal?.status === "blocked") this.options.completionState?.clearBlocked();
    const continuationMessages = turn.terminal
      ? [...turn.messages, runtimeContinuationMessage(turn.terminal)]
      : turn.messages;
    const previousTerminals = [
      ...(turn.previousTerminals ?? []),
      ...(turn.terminal ? [turn.terminal] : [])
    ];
    yield* this.runTurn(turn.prompt, {
      ...runOptions,
      maxSteps: remainingSteps,
      continueFrom: continuationMessages,
      recordSessionUserMessage: false,
      completedStepsBeforeRun: turn.completedSteps,
      initialRunFacts: restartRunFactsBudget(readRunFacts(turn.facts), turn.completedSteps === 0),
      previousTerminals
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

  private async *runTurn(
    input: string,
    runOptions: AgentRunOptions & {
      completedStepsBeforeRun?: number;
      initialRunFacts?: RunFacts;
      previousTerminals?: InterruptedTurnTerminal[];
    } = {}
  ): AsyncGenerator<AgentSessionEvent> {
    const release = this.beginOperation("agent turn");
    const turnController = new AbortController();
    const abortSignal = runOptions.abortSignal
      ? AbortSignal.any([runOptions.abortSignal, turnController.signal])
      : turnController.signal;
    const continuing = Boolean(runOptions.continueFrom?.length);
    const completedStepsBeforeRun = continuing ? runOptions.completedStepsBeforeRun ?? 0 : 0;
    if (!continuing) this.options.completionState?.reset();
    if (!Number.isSafeInteger(completedStepsBeforeRun) || completedStepsBeforeRun < 0) {
      throw new RangeError("Completed turn steps must be a non-negative safe integer.");
    }
    let workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined;
    const captureWorkspaceBaseline = async (): Promise<void> => {
      const baseline = workspaceBaseline ??= captureWorkspaceState(
        this.options.workspaceRoot,
        this.options.config.workspace.ignore
      );
      try {
        await baseline;
      } catch {
        // 已知文件工具仍会直接记录 changedFiles；快照不可用时不要留下一个稍后必然 reject
        // 的 Promise，把本来成功的工具调用变成回合级 provider_error。
        if (workspaceBaseline === baseline) workspaceBaseline = undefined;
      }
    };
    const usageBeforePreparation = this.usageRecords.length;
    let userMessageRecorded = false;
    const recordUserMessage = (): void => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      if (runOptions.recordSessionUserMessage === false) return;
      this.recorder.record({
        type: "user_message",
        content: input,
        attachments: sessionAttachments(runOptions.attachments),
        skills: this.options.skillPaths,
        contextUsage: this.contextMemory.getBudget(),
        contextState: this.contextMemory.persistedState(),
        preparationUsage: this.usageRecords.slice(usageBeforePreparation)
      });
    };
    try {
    // 新根输入明确放弃旧断点；否则它在首个新 step 落盘前崩溃时，/continue 会错误复活上一回合。
    if (!continuing) await this.turnStore.clear().catch(() => undefined);
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = cancelledTurn("Current turn cancelled before execution.", completedStepsBeforeRun);
      await this.turnStore.clear().catch(() => undefined);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "cancelled" };
      yield doneEvent(outcome);
      return;
    }
    try {
      await this.options.modelManager?.preparePrompt(abortSignal);
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? cancelledTurn("Current turn cancelled during model preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, "provider_error");
      this.recordError(outcome.error);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
      return;
    }
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) {
      recordUserMessage();
      const outcome = failedTurn("Native model runtime is not configured.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }
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
        input,
        systemPrompt,
        abortSignal,
        this.supportedAttachments(runOptions.attachments)
      );
    } catch (error) {
      recordUserMessage();
      const outcome = abortSignal.aborted
        ? cancelledTurn("Current turn cancelled during context preparation.", completedStepsBeforeRun)
        : failedTurn(errorMessage(error), completedStepsBeforeRun, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(outcome.error);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Agent run failed." };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
      return;
    }
    }
    if (abortSignal.aborted) {
      recordUserMessage();
      const outcome = cancelledTurn("Current turn cancelled during context preparation.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      await this.turnStore.clear().catch(() => undefined);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Current turn interrupted." };
      yield { type: "status", status: "cancelled" };
      yield doneEvent(outcome);
      return;
    }
    const configuredBudget = resolveRunBudget(this.options.config.agent);
    const remainingConfiguredSteps = configuredBudget.hardStepLimit - completedStepsBeforeRun;
    const requestedSteps = runOptions.maxSteps ?? remainingConfiguredSteps;
    if (
      !Number.isSafeInteger(requestedSteps)
      || requestedSteps < 1
      || requestedSteps > remainingConfiguredSteps
    ) {
      throw new RangeError(
        `Agent run maxSteps must be between 1 and ${String(Math.max(0, remainingConfiguredSteps))}; `
        + `the configured hard limit is ${String(configuredBudget.hardStepLimit)}.`
      );
    }
    const runBudget: RunBudget = {
      ...configuredBudget,
      softStepLimit: Math.min(configuredBudget.softStepLimit, completedStepsBeforeRun + requestedSteps),
      hardStepLimit: completedStepsBeforeRun + requestedSteps
    };
    yield* this.runNativeTurn({
      input,
      messages,
      runOptions,
      abortSignal,
      mode,
      runBudget,
      completedStepsBeforeRun,
      workspaceBaseline,
      captureWorkspaceBaseline
    });
    return;
    } finally {
      release();
    }
  }

  /**
   * Native Biny runtime path.
   *
   * The session boundary uses the same native message protocol as the loop,
   * provider transport and persisted turn state.
   */
  private async *runNativeTurn(args: NativeTurnArgs): AsyncGenerator<AgentSessionEvent> {
    const {
      input,
      messages,
      runOptions,
      abortSignal,
      mode,
      runBudget,
      completedStepsBeforeRun,
      workspaceBaseline,
      captureWorkspaceBaseline
    } = args;
    const nativeModel = this.options.modelManager?.getNativeModel() ?? this.options.model;
    const nativeSettings: NativeModelSettings | undefined = this.options.modelManager?.getNativeModelSettings()
      ?? (nativeModel ? { model: nativeModel, maxRetries: 0, contextWindow: undefined } : undefined);
    if (!nativeSettings) {
      const outcome = failedTurn("Native model runtime is not configured.", completedStepsBeforeRun);
      this.recordError(outcome.error);
      this.recordTurnOutcome(outcome);
      yield { type: "error", message: outcome.error ?? "Native model runtime is not configured." };
      yield { type: "status", status: "error" };
      yield doneEvent(outcome);
      return;
    }

    const permissionManager = this.options.permissionManager;
    const facts = new RunFactsCollector(runOptions.initialRunFacts);
    if (runOptions.verificationRequired === true) facts.setUserRequestedVerification(true);
    let pendingApprovalCount = 0;
    const confirmPermission = runOptions.confirmPermission === undefined
      ? undefined
      : async (request: AgentPermissionRequest): Promise<AgentPermissionResult> => {
        pendingApprovalCount += 1;
        facts.setPendingApprovals(pendingApprovalCount);
        try {
          return await runOptions.confirmPermission!(request);
        } finally {
          pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
          facts.setPendingApprovals(pendingApprovalCount);
        }
      };
    const runtime = this.runtimeContext(
      { ...runOptions, abortSignal, confirmPermission },
      captureWorkspaceBaseline
    );
    const allowedToolNames = mode === "plan"
      ? new Set(this.options.toolRegistry.list().filter((tool) => tool.risk === "read").map((tool) => tool.name))
      : undefined;
    const pendingEvents: AgentSessionEvent[] = [];
    const emitUpdate = (event: AgentSessionEvent): void => {
      if (
        event.type === "tool.started"
        || event.type === "tool.progress"
        || event.type === "tool.completed"
        || event.type === "tool.failed"
      ) facts.observeToolEvent(event);
      pendingEvents.push(event);
    };
    const coordinator = new ToolExecutionCoordinator(
      runtime,
      permissionManager,
      emitUpdate,
      undefined,
      allowedToolNames,
      {
        maxToolCalls: runBudget.maxToolCalls,
        maxRepeatedActions: runBudget.maxRepeatedActions,
        initialToolCallCount: runOptions.initialRunFacts?.actualToolCallCount,
        initialMaxRepeatedActionCount: runOptions.initialRunFacts?.maxRepeatedActionCount
      }
    );

    const verificationCommandExecutor = createControlledAcceptanceCommandExecutor({
      workspaceRoot: this.options.workspaceRoot,
      ignore: this.options.config.workspace.ignore,
      sandbox: this.options.config.sandbox,
      permissionManager,
      sessionId: this.recorder.sessionId,
      confirmPermission,
      maxConcurrency: this.options.config.agent.maxConcurrentTools,
      maxQueuedCommands: this.options.config.agent.maxQueuedToolCalls,
      beforeCommandExecution: async () => await captureWorkspaceBaseline()
    });
    const completionGate = new CompletionGate({
      verifier: createCompletionGateVerifier({
        workspaceRoot: this.options.workspaceRoot,
        ignore: this.options.config.workspace.ignore,
        managedProcesses: this.options.managedProcesses,
        commandExecutor: verificationCommandExecutor
      }),
      listTodos: () => this.options.todoStore?.list() ?? [],
      listRequestedChecks: () => [
        ...(runOptions.verificationChecks ?? []).map((check) => ({ ...check })),
        ...(this.options.completionState?.listChecks() ?? [])
      ],
      blockedState: () => this.options.completionState?.getBlocked(),
      onVerification: (verification) => facts.recordVerification(verification)
    });

    const nativeContext = messagesToAgentContext(messages);
    nativeContext.tools = nativeSettings.model.supportsTools === false ? [] : coordinator.createAgentTools();
    let completionDecision: CompletionDecision | undefined;
    let pendingSteering: AgentMessage[] = [];
    let lastAssistant: AgentAssistantMessage | undefined;
    let newMessages: AgentMessage[] = [];
    let observedSteps = 0;
    let reasoningActive = false;
    let reasoningOutput = "";
    const stepUsageRecords: SessionUsage[] = [];
    let streamFailure: string | undefined;
    let streamFailureReported = false;
    let softLimitWarningInjected = completedStepsBeforeRun >= runBudget.softStepLimit;

    yield { type: "status", status: "thinking" };
    try {
      const loop = agentLoopContinue(nativeContext, {
        model: nativeSettings.model,
        tools: nativeContext.tools,
        modelOptions: {
          maxOutputTokens: nativeSettings.maxOutputTokens,
          reasoning: nativeSettings.reasoning,
          providerOptions: nativeSettings.providerOptions,
          timeoutMs: nativeSettings.timeoutMs
        },
        maxSteps: runBudget.hardStepLimit - completedStepsBeforeRun,
        transformContext: async (contextMessages) => {
          const absoluteStep = completedStepsBeforeRun + observedSteps;
          if (!softLimitWarningInjected && absoluteStep >= runBudget.softStepLimit) {
            softLimitWarningInjected = true;
            return [
              ...contextMessages,
              {
                role: "user",
                content: "## Biny run budget\n\nThe soft limit of provider steps has been reached. Review unfinished work, avoid repeated actions, run the necessary checks, and converge without claiming completion early."
              }
            ];
          }
          return contextMessages;
        },
        getSteeringMessages: async () => {
          const next = pendingSteering;
          pendingSteering = [];
          return next;
        },
        shouldStopAfterTurn: async (turn) => {
          // A tool-producing assistant turn must always be followed by a model
          // turn so it can consume the structured results and formulate an answer.
          if (turn.message.content.some((part) => part.type === "toolCall")) return false;
          await coordinator.waitForIdle();
          await refreshRunFacts(
            facts,
            workspaceBaseline,
            this.options.workspaceRoot,
            this.options.config.workspace.ignore,
            this.options.managedProcesses
          );
          const decision = await completionGate.decide(facts.snapshot(abortSignal.aborted), {
            steps: completedStepsBeforeRun + observedSteps,
            softStepLimit: runBudget.softStepLimit,
            hardStepLimit: runBudget.hardStepLimit,
            maxToolCalls: runBudget.maxToolCalls,
            maxCompletionContinuations: runBudget.maxCompletionContinuations,
            maxRepeatedActions: runBudget.maxRepeatedActions
          }, abortSignal);
          if (decision.kind === "continue") {
            pendingSteering.push({ role: "user", content: modelMessageContentText(decision.feedback.content) });
            return false;
          }
          completionDecision = decision;
          return true;
        }
      }, abortSignal);

      for await (const event of loop) {
        while (pendingEvents.length) {
          const next = pendingEvents.shift();
          if (next) yield next;
        }
        if (event.type === "message_update") {
          if (event.event.type === "text-delta") {
            yield { type: "assistant.delta", content: event.event.text };
          } else if (event.event.type === "reasoning-start") {
            if (!reasoningActive) {
              reasoningActive = true;
              yield { type: "reasoning.started", phase: observedSteps === 0 ? "initial" : "continuing" };
            }
          } else if (event.event.type === "reasoning-delta") {
            reasoningOutput += event.event.text;
            yield { type: "reasoning.delta", content: event.event.text };
          } else if (event.event.type === "reasoning-end" && reasoningActive) {
            reasoningActive = false;
            yield { type: "reasoning.completed" };
          } else if (event.event.type === "error") {
            streamFailure = errorMessage(event.event.error);
            streamFailureReported = true;
            yield { type: "error", message: streamFailure, fatal: true };
          }
        } else if (event.type === "turn_end") {
          observedSteps += 1;
          lastAssistant = event.message;
          const usage = event.message.usage;
          if (usage) {
            stepUsageRecords.push(this.recordModelUsage(usage, mode === "plan" ? "plan" : "agent"));
            this.contextMemory.recordProviderUsage(usage);
          }
          // 保存每个已完成的工具步。进程可能在下一次 provider 请求前退出，
          // 续跑必须从最后一个完整的 assistant + tool result context 开始。
          if (
            event.toolResults.length > 0
            && completedStepsBeforeRun + observedSteps < runBudget.hardStepLimit
          ) {
            await this.turnStore.save(
              input,
              agentMessagesToModel(event.messages),
              completedStepsBeforeRun + observedSteps,
              facts.snapshot(false),
              undefined,
              runOptions.previousTerminals
            ).catch(() => undefined);
          }
        } else if (event.type === "agent_end") {
          newMessages = event.messages;
        } else if (event.type === "error") {
          if (event.fatal) {
            streamFailure ??= event.error;
            streamFailureReported = true;
            yield { type: "error", message: event.error, fatal: true };
          } else {
            yield { type: "error", message: event.error };
          }
        }
      }
      while (pendingEvents.length) {
        const next = pendingEvents.shift();
        if (next) yield next;
      }
      await coordinator.waitForIdle();
      if (reasoningActive) yield { type: "reasoning.completed" };
      if (streamFailure) throw new Error(streamFailure);
      if (!completionDecision) {
        completionDecision = {
          kind: "incomplete",
          reason: "hard_step_limit",
          summary: `The run reached its hard limit of ${String(runBudget.hardStepLimit)} provider steps.`,
          resumable: true
        };
      }
      const finalDecision = completionDecision;
      if (!finalDecision || finalDecision.kind === "continue") throw new Error("Native completion gate returned an unconsumed continuation.");

      const finalMessages = agentMessagesToModel([...nativeContext.messages, ...newMessages]);
      this.contextMemory.replaceHistory(finalMessages);
      const usageRecord = stepUsageRecords.length ? sumSessionUsage(stepUsageRecords) : undefined;
      const content = lastAssistant ? agentMessageText(lastAssistant) : "";
      await recordNativeTelemetryEnd(this.options.config, this.options.workspaceRoot, {
        provider: nativeSettings.model.provider,
        modelId: nativeSettings.model.modelId,
        usage: lastAssistant?.usage,
        text: content
      });
      this.recorder.record({
        type: "assistant_message",
        content,
        reasoningContent: reasoningOutput || undefined,
        usage: usageRecord,
        relatedUsage: this.takeRelatedUsage(),
        contextState: this.contextMemory.snapshot()
      });
      const outcome = completionOutcome(
        finalDecision,
        content,
        lastAssistant?.stopReason,
        completedStepsBeforeRun + observedSteps,
        usageRecord
      );
      if (content && (outcome.status === "completed" || outcome.status === "incomplete" || outcome.status === "blocked")) {
        yield { type: "assistant.completed", content };
      }
      if (outcome.status === "completed") {
        this.rememberSuccessfulTask(input, content);
        yield { type: "status", status: "completed" };
      } else if (outcome.status === "incomplete") {
        yield { type: "status", status: "incomplete" };
      } else if (outcome.status === "blocked") {
        yield { type: "status", status: "blocked" };
      } else if (outcome.status === "cancelled") {
        yield { type: "status", status: "cancelled" };
      } else {
        this.recordError(outcome.error ?? "Native agent run failed.");
        yield { type: "error", message: outcome.error ?? "Native agent run failed." };
        yield { type: "status", status: "error" };
      }
      if (outcome.status === "blocked" || outcome.status === "incomplete" && outcome.resumable === true) {
        await this.turnStore.save(
          input,
          finalMessages,
          0,
          facts.snapshot(false),
          {
            status: outcome.status,
            stopReason: outcome.stopReason,
            summary: outcome.error ?? `${outcome.status} (${outcome.stopReason})`,
            blockedReason: outcome.blockedReason,
            requiredAction: outcome.requiredAction
          },
          runOptions.previousTerminals
        ).catch(() => undefined);
      } else {
        await this.turnStore.clear().catch(() => undefined);
      }
      this.recordTurnOutcome(outcome);
      yield doneEvent(outcome);
    } catch (error) {
      const message = errorMessage(error);
      const outcome = abortSignal.aborted
        ? cancelledTurn(message || "Current turn cancelled.", completedStepsBeforeRun + observedSteps)
        : failedTurn(message, completedStepsBeforeRun + observedSteps, isTimeoutFailure(error) ? "timeout" : "provider_error");
      this.recordError(message);
      if (outcome.status === "cancelled") await this.turnStore.clear().catch(() => undefined);
      this.recordTurnOutcome(outcome);
      if (!streamFailureReported) yield { type: "error", message };
      yield { type: "status", status: outcome.status === "cancelled" ? "cancelled" : "error" };
      yield doneEvent(outcome);
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
      await this.options.todoStore?.useSession(replacementRecorder.sessionId);
      restoreCompletionState(this.options.completionState, replay.events);
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
    usage: AgentUsage,
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

  private recordTurnOutcome(outcome: AgentTurnOutcome): void {
    this.recorder.record({
      type: "turn_status",
      status: outcome.status,
      stopReason: outcome.stopReason,
      steps: outcome.steps,
      summary: outcome.error,
      resumable: outcome.resumable,
      blockedReason: outcome.blockedReason,
      requiredAction: outcome.requiredAction,
      affectedTodoIds: outcome.affectedTodoIds
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
    usage: AgentUsage,
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

  private runtimeContext(
    runOptions: AgentRunOptions,
    beforeWorkspaceMutation?: () => Promise<void>
  ): AgentRuntimeContext {
    const model = this.options.modelManager?.getModel() ?? this.options.model;
    if (!model) throw new Error("Native model runtime is not configured.");
    return {
      workspaceRoot: this.options.workspaceRoot,
      config: this.options.config,
      ...(model ? { model } : {}),
      recorder: this.recorder,
      contextMemory: this.contextMemory,
      toolRegistry: this.options.toolRegistry,
      permissionManager: this.options.permissionManager,
      confirmPermission: runOptions.confirmPermission,
      createCheckpoint: this.options.createCheckpoint,
      beforeWorkspaceMutation,
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

function messagesToAgentContext(messages: ModelMessage[]): AgentContext {
  const systemParts: string[] = [];
  const contextMessages: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(modelMessageContentText(message.content));
      continue;
    }
    if (message.role === "user") {
      contextMessages.push({ role: "user", content: nativeUserContent(message.content), timestamp: Date.now() });
      continue;
    }
    if (message.role === "assistant") {
      const content: AgentAssistantMessage["content"] = Array.isArray(message.content)
        ? message.content.flatMap((part): AgentAssistantMessage["content"] => {
          if (part.type === "text") return [{ type: "text", text: part.text }];
          if (part.type === "reasoning") return [{
            type: "reasoning",
            text: part.text,
            providerMetadata: (() => {
              const reasoning = part as unknown as {
                providerMetadata?: Record<string, unknown>;
                providerOptions?: Record<string, unknown>;
              };
              return reasoning.providerMetadata ?? reasoning.providerOptions;
            })()
          }];
          if (part.type === "tool-call") return [{
            type: "toolCall",
            id: part.toolCallId,
            name: part.toolName,
            arguments: isRecord(part.input) ? part.input : parseNativeRecord(part.input)
          }];
          return [];
        })
        : [{ type: "text" as const, text: message.content }];
      contextMessages.push({ role: "assistant", content });
      continue;
    }
    const result = Array.isArray(message.content) ? message.content[0] : undefined;
    if (result?.type === "tool-result") {
      contextMessages.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: [{ type: "text", text: stringifyNativeValue(result.output) }],
        isError: isRecord(result) && result.isError === true
      });
    }
  }
  return {
    systemPrompt: systemParts.filter(Boolean).join("\n\n") || undefined,
    messages: contextMessages,
    tools: []
  };
}

function agentMessagesToModel(messages: AgentMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "user") {
      return { role: "user", content: nativeUserContentToModel(message.content) };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "reasoning") return { type: "reasoning", text: part.text, providerOptions: part.providerMetadata };
          return { type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.arguments };
        })
      };
    }
    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: message.details ?? message.content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("\n"),
        isError: message.isError === true
      }]
    };
  });
}

function nativeUserContent(
  content: unknown
): AgentUserMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
    if (part.type !== "file") return [];
    const data = typeof part.data === "string"
      ? part.data
      : isRecord(part.data) && typeof part.data.data === "string"
        ? part.data.data
        : undefined;
    if (!data) return [];
    const match = /^data:([^;]+);base64,(.*)$/u.exec(data);
    return [{ type: "image", data: match?.[2] ?? data, mimeType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream" }];
  });
}

function nativeUserContentToModel(
  content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>
): ModelMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text ?? "" }
    : { type: "file", data: `data:${part.mimeType ?? "application/octet-stream"};base64,${part.data ?? ""}`, mediaType: part.mimeType ?? "application/octet-stream" });
}

function modelMessageContentText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text;
    return "";
  }).join("");
}

function agentMessageText(message: AgentAssistantMessage): string {
  return message.content.filter((part): part is Extract<AgentAssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function stringifyNativeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function parseNativeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function modelIdentifier(model: AgentModel): string {
  return model.modelId;
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

function completionOutcome(
  decision: Exclude<CompletionDecision, { kind: "continue" }>,
  output: string,
  finishReason: string | undefined,
  steps: number,
  usage?: SessionUsage
): AgentTurnOutcome {
  if (decision.kind === "complete") {
    return { status: "completed", stopReason: "completion_gate", finishReason, steps, output, usage };
  }
  if (decision.kind === "blocked") {
    return {
      status: "blocked",
      stopReason: "blocked",
      finishReason,
      steps,
      output,
      usage,
      error: decision.summary,
      resumable: decision.reason !== "missing_user_input" && decision.reason !== "unsafe_action_required",
      blockedReason: decision.reason,
      requiredAction: decision.requiredAction,
      affectedTodoIds: decision.affectedTodoIds
    };
  }
  if (decision.kind === "incomplete") {
    return {
      status: "incomplete",
      stopReason: decision.reason === "model_output_limit" ? "model_length" : decision.reason,
      finishReason,
      steps,
      output,
      usage,
      error: decision.summary,
      resumable: decision.resumable
    };
  }
  return {
    status: "cancelled",
    stopReason: "cancelled",
    finishReason,
    steps,
    output,
    usage,
    error: "Current turn was cancelled."
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

function cancelledTurn(message: string, steps: number): AgentTurnOutcome {
  return {
    status: "cancelled",
    stopReason: "cancelled",
    finishReason: undefined,
    steps,
    output: "",
    usage: undefined,
    error: message
  };
}

function createCompletionGateVerifier(options: {
  workspaceRoot: string;
  ignore?: string[];
  managedProcesses?: ManagedProcessInspector;
  commandExecutor: AcceptanceCommandExecutor;
}): CompletionGateVerifier {
  const verifier = new AcceptanceVerifier({
    workspaceRoot: options.workspaceRoot,
    ignore: options.ignore,
    managedProcesses: options.managedProcesses,
    commandExecutor: options.commandExecutor
  });
  let plan: AgentVerificationPlan = { required: false, criteria: [], reasons: [] };
  return {
    derive: async (
      facts: RunFacts,
      requestedChecks: readonly StructuredVerificationCheck[]
    ): Promise<CompletionVerification> => {
      const checks: NonNullable<AgentVerificationFacts["checks"]> = requestedChecks.flatMap((check) => {
        if (check.kind !== "command" || !check.command) return [];
        return [{
          id: check.id,
          command: check.command,
          cwd: check.cwd,
          timeoutMs: undefined,
          description: check.description
        }];
      });
      const processes = new Map<string, NonNullable<AgentVerificationFacts["startedProcesses"]>[number]>();
      for (const processId of facts.startedProcessIds) {
        const process = facts.activeProcesses.find((candidate) => candidate.processId === processId);
        const readinessType = processReadinessType(process?.readiness);
        processes.set(processId, {
          processId,
          cwd: process?.cwd,
          url: process?.url,
          readinessType,
          requireHttpReadiness: readinessType === "http" ? true : undefined,
          description: process?.command
        });
      }
      for (const check of requestedChecks) {
        if (check.kind !== "managed_process" || !check.processId) continue;
        processes.set(check.processId, {
          processId: check.processId,
          cwd: check.cwd,
          url: undefined,
          readinessType: undefined,
          requireHttpReadiness: undefined,
          description: check.description
        });
      }
      plan = await deriveAgentVerificationPlan(
        options.workspaceRoot,
        {
          changedFiles: facts.changedFiles,
          workspaceMutationObserved: facts.workspaceMutationObserved,
          userRequestedVerification: facts.userRequestedVerification,
          checks,
          startedProcesses: [...processes.values()]
        },
        options.ignore
      );
      return {
        required: plan.required,
        checks: requestedChecks.map((check) => ({ ...check }))
      };
    },
    verify: async (
      _requirement: CompletionVerification,
      signal?: AbortSignal
    ): Promise<VerificationFact> => {
      const result = await verifier.verifyCriteria(plan.criteria, {
        signal,
        requireCriteria: true
      });
      return {
        passed: result.passed,
        summary: result.summary,
        evidence: result.evidence.map((evidence) => ({
          id: evidence.criterionId,
          passed: evidence.passed,
          summary: evidence.summary,
          details: evidence.details
        }))
      };
    }
  };
}

async function refreshRunFacts(
  facts: RunFactsCollector,
  workspaceBaseline: Promise<WorkspaceStateSnapshot> | undefined,
  workspaceRoot: string,
  ignore: string[],
  managedProcesses?: ManagedProcessInspector
): Promise<void> {
  if (workspaceBaseline) {
    try {
      const [before, after] = await Promise.all([
        workspaceBaseline,
        captureWorkspaceState(workspaceRoot, ignore)
      ]);
      facts.setChangedFiles(diffWorkspaceStates(before, after).changedFiles);
    } catch {
      // 已知文件工具的路径已经由 RunFactsCollector 记录；快照失败时保留这些事实。
    }
  }
  if (!managedProcesses) return;
  let processes: Awaited<ReturnType<ManagedProcessInspector["listProcesses"]>>;
  try {
    processes = await managedProcesses.listProcesses();
  } catch {
    return;
  }
  facts.setActiveProcesses(processes.map((process): ProcessFact => ({
    processId: process.processId,
    state: process.state,
    command: process.command,
    cwd: process.cwd,
    url: process.url,
    readiness: process.readiness
  })));
}

function processReadinessType(value: unknown): "http" | "tcp" | "log" | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const type = value.type;
  return type === "http" || type === "tcp" || type === "log" ? type : undefined;
}

function restoreCompletionState(
  store: CompletionStateStore | undefined,
  events: SessionReplay["events"]
): void {
  if (!store) return;
  store.reset();
  for (const event of events) {
    if (event.type === "user_message" && !event.auditOnly) {
      store.reset();
      continue;
    }
    if (event.type !== "tool_result") continue;
    if (event.tool === "report_blocked") {
      const blocked = readBlockedState(event.result);
      if (blocked) store.reportBlocked(blocked);
    } else if (event.tool === "request_verification") {
      const checks = readVerificationChecks(event.result);
      if (checks) store.replaceChecks(checks);
    }
  }
}

function readBlockedState(value: unknown): ReturnType<CompletionStateStore["getBlocked"]> {
  if (!isRecord(value)) return undefined;
  const reason = value.reason;
  if (
    reason !== "missing_user_input"
    && reason !== "waiting_for_approval"
    && reason !== "permission_denied"
    && reason !== "missing_dependency"
    && reason !== "environment_unavailable"
    && reason !== "external_service_failure"
    && reason !== "unsafe_action_required"
  ) return undefined;
  if (typeof value.summary !== "string" || !value.summary) return undefined;
  const requiredAction = typeof value.requiredAction === "string" ? value.requiredAction : undefined;
  const affectedTodoIds = Array.isArray(value.affectedTodoIds)
    ? value.affectedTodoIds.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    reason,
    summary: value.summary,
    requiredAction,
    affectedTodoIds
  };
}

function readVerificationChecks(value: unknown): StructuredVerificationCheck[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.checks)) return undefined;
  const checks = value.checks.flatMap((item): StructuredVerificationCheck[] => {
    if (
      !isRecord(item)
      || item.kind !== "command"
      || typeof item.id !== "string"
      || typeof item.description !== "string"
      || typeof item.command !== "string"
    ) return [];
    return [{
      id: item.id,
      kind: "command",
      description: item.description,
      command: item.command,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      processId: undefined
    }];
  });
  return checks.length ? checks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRunFacts(value: unknown): RunFacts | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.actualToolCallCount)
    || typeof value.actualToolCallCount !== "number"
    || value.actualToolCallCount < 0
    || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.executedCommands)
    || !Array.isArray(value.failedToolCalls)
    || !Number.isSafeInteger(value.pendingApprovals)
    || typeof value.pendingApprovals !== "number"
    || !Number.isSafeInteger(value.activeToolCalls)
    || typeof value.activeToolCalls !== "number"
    || !Array.isArray(value.activeProcesses)
    || !Array.isArray(value.startedProcessIds)
    || !Array.isArray(value.verificationResults)
    || typeof value.userCancelled !== "boolean"
    || !Number.isSafeInteger(value.maxRepeatedActionCount)
    || typeof value.maxRepeatedActionCount !== "number"
  ) return undefined;
  return structuredClone(value) as unknown as RunFacts;
}

function restartRunFactsBudget(facts: RunFacts | undefined, restartBudget: boolean): RunFacts | undefined {
  if (!facts || !restartBudget) return facts;
  return {
    ...facts,
    actualToolCallCount: 0,
    pendingApprovals: 0,
    activeToolCalls: 0,
    userCancelled: false,
    maxRepeatedActionCount: 0
  };
}

function runtimeContinuationMessage(terminal: InterruptedTurnTerminal): ModelMessage {
  return {
    role: "system",
    content: [
      "## Biny runtime continuation",
      "",
      `The previous run stopped as ${terminal.status} (${terminal.stopReason}): ${terminal.summary}`,
      "The user explicitly requested continuation. Re-evaluate the remaining structured facts and continue the same task without repeating completed work."
    ].join("\n")
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
