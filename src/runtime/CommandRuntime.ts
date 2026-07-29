/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { randomUUID } from "node:crypto";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import type { AgentConfig } from "../config/schema.js";
import { AgentSession } from "../agent/AgentSession.js";
import { ModelManager, modelRuntimeInfo, type ModelRuntimeInfo } from "../llm/ModelManager.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry } from "../tools/registry.js";
import { createTodoTool } from "../tools/todo.js";
import { TodoStore } from "../session/todoStore.js";
import type { InterruptedTurn } from "../session/turnStore.js";
import { forkSession, type ForkedSession } from "../session/fork.js";
import { CheckpointStore, type Checkpoint, type RestoreSummary } from "../session/checkpointStore.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { createSkillTool, loadSkills, type SkillBundle } from "../extensions/skills.js";
import { loadPlugins } from "../extensions/plugins.js";
import { createMcpResourceTools, McpToolHost, type McpServerStatus } from "../extensions/mcp.js";
import { createSubagentTool, runSubagentTask as executeSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { buildSubagentDefinitionsPrompt, loadSubagentDefinitions, type SubagentDefinition } from "../extensions/agents.js";
import { createMemoryTools } from "../extensions/memory.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createModelSettings, type ModelSettings } from "../llm/factory.js";
import {
  SubagentTaskManager,
  type SubagentTaskRunOptions,
  type SubagentTaskSnapshot,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { ManagedProcessService } from "./ManagedProcessService.js";
import { subagentAccessMode } from "./subagentAccess.js";
import { modelReasoningConfig } from "../ai/capabilities.js";
import { attachmentRoot, ensureAttachmentRoot } from "../attachments/store.js";

export interface CommandRuntime {
  workspaceRoot: string;
  /** Location that owns durable runtime/session state. Project work uses the workspace; desktop may pass a global root for non-project sessions. */
  persistenceRoot: string;
  config: AgentConfig;
  agent: AgentSession;
  managedProcesses: ManagedProcessService;
  extensionReport(section?: ExtensionSection): string;
  /** 从某个时点分叉出一条新会话；原会话不受影响。 */
  forkSession(session: string | undefined, upToEvent?: number): Promise<ForkedSession>;
  /** 上次被打断、尚未收尾的回合。 */
  interruptedTurn(): Promise<InterruptedTurn | undefined>;
  /** 工作区快照；非 git 目录下为 undefined。 */
  listCheckpoints(): Promise<Checkpoint[]>;
  restoreCheckpoint(id: string): Promise<RestoreSummary>;
  reconnectMcpServer(serverName: string): Promise<McpServerStatus>;
  getSubagentInfo(): ModelRuntimeInfo;
  /** 实时重新扫描具名子代理定义（会话期间可编辑生效）。 */
  listSubagentAgents(): Promise<SubagentDefinition[]>;
  startSubagentTask(task: string, options?: SubagentTaskRunOptions): SubmittedSubagentTask;
  runSubagentTask(task: string, options?: SubagentTaskRunOptions): Promise<string>;
  listSubagentTasks(): SubagentTaskSnapshot[];
  cancelSubagentTask(taskId: string, reason?: string): boolean;
  subscribeSubagentTasks(listener: (task: SubagentTaskSnapshot) => void): () => void;
  setSubagentParentRunId(parentRunId?: string): void;
  cancelSubagentTasks(parentRunId: string, reason?: string): void;
  close(): Promise<void>;
}

export interface CommandRuntimeOptions {
  persistenceRoot?: string;
  configStore?: AgentConfigStore;
  attachmentRoot?: string;
}

export async function createCommandRuntime(workspaceRoot: string, options: CommandRuntimeOptions = {}): Promise<CommandRuntime> {
  // Project sessions default to the workspace (`.biny/sessions`). Callers may override for non-project/global storage.
  const persistenceRoot = options.persistenceRoot ?? workspaceRoot;
  const projectAttachmentRoot = options.attachmentRoot ?? attachmentRoot(persistenceRoot);
  const configStore = options.configStore ?? createFileConfigStore(persistenceRoot);
  const config = await configStore.load(workspaceRoot);
  const modelManager = new ModelManager(workspaceRoot, config, configStore);
  await ensureAgentDirs(persistenceRoot);
  await ensureAttachmentRoot(persistenceRoot);
  const recorder = new SessionRecorder(persistenceRoot);
  const managedProcesses = new ManagedProcessService({ workspaceRoot, persistenceRoot });
  await managedProcesses.initialize();
  const toolRegistry = createToolRegistry(
    { workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: projectAttachmentRoot },
    config.web.search,
    managedProcesses,
    config.web.fetch,
    config.sandbox,
    config.web.cookies
  );
  // 快照挂在工作区的 git 仓库上；非 git 目录下这项能力直接不可用。
  const checkpoints = config.checkpoints.enabled ? await CheckpointStore.open(workspaceRoot) : undefined;
  const todos = new TodoStore(persistenceRoot, recorder.sessionId);
  await todos.initialize();
  toolRegistry.registerBuiltinTool(createTodoTool(todos));
  const permissionManager = new PermissionManager({ ...config.permission, source: "global agent.config.json + project .biny/settings.json" });
  const mcpHost = new McpToolHost();
  let skills: SkillBundle | undefined;
  let agent: AgentSession | undefined;
  let subagentParentRunId: string | undefined;
  let subagentDefinitions: SubagentDefinition[] = [];
  // 具名子代理定义每次委派时重新读取（会话期间可编辑生效）；启动时读一次用于 prompt 与报告。
  const loadAgentDefinitions = (): Promise<SubagentDefinition[]> => loadSubagentDefinitions({
    workspaceRoot,
    projectPaths: config.extensions.subagent.agentPaths
  });
  const subagentOptions: SubagentOptions = {
    workspaceRoot,
    config,
    getModelSettings: (modelAlias?: string) => subagentModelSettings(config, modelManager, modelAlias),
    getAccessMode: () => subagentAccessMode(permissionManager),
    getParentRunId: () => subagentParentRunId,
    loadAgentDefinitions,
    toolRegistry,
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias)
  };
  const subagentTaskManager = config.extensions.subagent.enabled
    ? new SubagentTaskManager({
      maxConcurrentSubagents: config.extensions.subagent.maxConcurrentSubagents,
      maxPendingSubagents: config.extensions.subagent.maxPendingSubagents,
      timeoutMs: config.extensions.subagent.timeoutMs,
      execute: async (task, context) => await executeSubagentTask(subagentOptions, task, context.signal, context.accessMode, context.agent)
    })
    : undefined;
  let loadedPlugins: string[] = [];
  try {
    // 技能扫描可能因项目内配置路径的软链/硬链问题抛错，放在清理保护内执行。
    skills = await loadSkills({ workspaceRoot, projectPaths: config.extensions.skills });
    if (skills.skills.length) toolRegistry.registerUserTool(createSkillTool(skills));
    // 先注册通用资源工具。若服务器工具归一化后撞名，connectConfiguredServers 中的
    // 按工具隔离会跳过它，而不会让整个 runtime 在之后重复注册时失败。
    if (Object.values(config.extensions.mcp).some((server) => server.enabled)) {
      for (const tool of createMcpResourceTools(mcpHost)) toolRegistry.registerMcpTool(tool);
    }
    await mcpHost.connectConfiguredServers(workspaceRoot, config, toolRegistry);
    loadedPlugins = await loadPlugins(workspaceRoot, config.extensions.plugins, config, toolRegistry);
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions, subagentTaskManager!));
      subagentDefinitions = await loadAgentDefinitions();
    }
    if (config.context.memory.enabled) {
      // 记忆工具通过闭包延迟取 LocalMemory：注册发生在 AgentSession 创建前，调用发生在其后。
      for (const tool of createMemoryTools(() => agent?.getLocalMemory())) toolRegistry.registerBuiltinTool(tool);
    }
    agent = new AgentSession({
      workspaceRoot,
      persistenceRoot,
      configStore,
      config,
      model: modelManager.getModel(),
      modelManager,
      toolRegistry,
      permissionManager,
      recorder,
      skillPrompt: skills.prompt,
      subagentPrompt: buildSubagentDefinitionsPrompt(subagentDefinitions),
      skillPaths: skills.paths,
      mcpPrompt: () => mcpHost.instructionsPrompt(),
      todoPrompt: () => todos.promptSection(),
      createCheckpoint: checkpoints ? async (label) => await checkpoints.create(label) : undefined,
      attachmentRoot: projectAttachmentRoot
    });
    await agent.initialize();
  } catch (error) {
    await subagentTaskManager?.close();
    await managedProcesses.close();
    await mcpHost.close();
    await recorder.close();
    throw error;
  }
  if (!agent || !skills) throw new Error("Failed to initialize Biny agent runtime.");

  const loadedSkills = skills;
  // MCP 连接状态与工具集合在运行期会变（断线、重连、list_changed），报告每次实时取。
  const extensionStatus = (): ExtensionStatus => ({
    mcp: mcpHost.listServers(),
    skills: [...loadedSkills.skills],
    plugins: [...loadedPlugins],
    subagent: { ...config.extensions.subagent, agents: [...subagentDefinitions] },
    toolScheduling: {
      maxConcurrentTools: config.agent.maxConcurrentTools,
      maxQueuedToolCalls: config.agent.maxQueuedToolCalls
    },
    toolCounts: createToolCounts(toolRegistry.listEntries())
  });

  const startSubagentTask = (task: string, taskOptions?: SubagentTaskRunOptions): SubmittedSubagentTask => {
    if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in agent.config.json.");
    if (!subagentTaskManager) throw new Error("Subagent runtime is unavailable.");
    const taskId = taskOptions?.taskId ?? randomUUID();
    agent.recordHostedUserMessage(task);
    const sequence = agent.recordHostedToolCall("delegate_task", taskOptions?.agent ? { task, agent: taskOptions.agent } : { task }, taskId);
    let submitted: SubmittedSubagentTask;
    try {
      taskOptions?.signal?.throwIfAborted();
      submitted = subagentTaskManager.submit(task, {
        taskId,
        parentRunId: taskOptions?.parentRunId,
        signal: taskOptions?.signal,
        timeoutMs: taskOptions?.timeoutMs,
        accessMode: taskOptions?.accessMode ?? subagentAccessMode(permissionManager),
        agent: taskOptions?.agent
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      agent.recordHostedToolResult("delegate_task", { error: failure.message }, taskId, sequence);
      throw failure;
    }

    const completion = submitted.completion.then(
      (result) => {
        agent.recordHostedToolResult("delegate_task", result, taskId, sequence);
        agent.recordHostedAssistantMessage(result);
        return result;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        agent.recordHostedToolResult("delegate_task", { error: failure.message }, taskId, sequence);
        throw failure;
      }
    );
    // Background CLI starts intentionally do not await completion. Attaching a
    // rejection observer keeps cancellation/failure from becoming unhandled;
    // foreground callers can still await the original completion promise.
    void completion.catch(() => undefined);
    return { ...submitted, completion };
  };

  const runtime: CommandRuntime = {
    workspaceRoot,
    persistenceRoot,
    config,
    agent,
    managedProcesses,
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus(), section),
    forkSession: async (session: string | undefined, upToEvent?: number): Promise<ForkedSession> =>
      await forkSession(persistenceRoot, session, upToEvent === undefined ? {} : { upToEvent }),
    interruptedTurn: async (): Promise<InterruptedTurn | undefined> => await agent.interruptedTurn(),
    listCheckpoints: async (): Promise<Checkpoint[]> => checkpoints ? await checkpoints.list() : [],
    restoreCheckpoint: async (id: string): Promise<RestoreSummary> => {
      if (!checkpoints) throw new Error("Checkpoints need a git repository; this workspace is not one.");
      return await checkpoints.restore(id);
    },
    reconnectMcpServer: async (serverName: string): Promise<McpServerStatus> => await mcpHost.reconnectServer(serverName),
    getSubagentInfo: (): ModelRuntimeInfo => subagentRuntimeInfo(config),
    listSubagentAgents: async (): Promise<SubagentDefinition[]> => {
      subagentDefinitions = await loadAgentDefinitions();
      return [...subagentDefinitions];
    },
    startSubagentTask,
    runSubagentTask: async (task: string, taskOptions?: SubagentTaskRunOptions): Promise<string> => await startSubagentTask(task, taskOptions).completion,
    listSubagentTasks: (): SubagentTaskSnapshot[] => subagentTaskManager?.listSnapshots() ?? [],
    cancelSubagentTask: (taskId: string, reason?: string): boolean => subagentTaskManager?.cancelTask(taskId, reason) ?? false,
    subscribeSubagentTasks: (listener: (task: SubagentTaskSnapshot) => void): (() => void) =>
      subagentTaskManager?.subscribe(listener) ?? (() => undefined),
    setSubagentParentRunId: (parentRunId?: string): void => {
      subagentParentRunId = parentRunId;
    },
    cancelSubagentTasks: (parentRunId: string, reason?: string): void => {
      subagentTaskManager?.cancelParent(parentRunId, reason);
    },
    close: async () => {
      try {
        await subagentTaskManager?.close();
        await agent.close();
      } finally {
        try {
          await managedProcesses.close();
        } finally {
          await mcpHost.close();
        }
      }
    }
  };
  return runtime;
}

function subagentModelSettings(config: AgentConfig, modelManager: ModelManager, modelAlias?: string): ModelSettings {
  // 具名定义的 model 覆盖优先于全局 subagent model；两者都未配置时沿用当前会话模型。
  const alias = modelAlias ?? config.extensions.subagent.model;
  if (!alias) return modelManager.getModelSettings();
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  if (model.supportsTools === false) throw new Error(`Subagent model ${alias} does not support tools.`);
  const reasoning = modelReasoningConfig(model);
  const modelConfig = {
    ...config,
    defaultModel: alias,
    thinking: reasoning
      ? { enabled: true, effort: reasoning.defaultEffort }
      : { enabled: false, effort: "high" as const }
  };
  return createModelSettings(modelConfig, alias);
}

function subagentRuntimeInfo(config: AgentConfig): ModelRuntimeInfo {
  const alias = config.extensions.subagent.model;
  if (!alias) return modelRuntimeInfo(config);
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  const thinking = modelReasoningConfig(model)?.defaultEffort ?? "off";
  return modelRuntimeInfo({
    ...config,
    defaultModel: alias,
    thinking: {
      enabled: thinking !== "off",
      effort: thinking === "off" ? config.thinking.effort : thinking
    }
  });
}

export async function withCommandRuntime(workspaceRoot: string, fn: (runtime: CommandRuntime) => Promise<void>): Promise<void> {
  const runtime = await createCommandRuntime(workspaceRoot);
  try {
    await fn(runtime);
  } catch (error) {
    // 命令层的异常统一落到 session，方便 resume 时看到失败原因。
    runtime.agent.recordError(error);
    throw error;
  } finally {
    await runtime.close();
  }
}
