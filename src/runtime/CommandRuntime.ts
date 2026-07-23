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
import { PermissionManager } from "../permission/PermissionManager.js";
import { loadSkills } from "../extensions/skills.js";
import { loadPlugins } from "../extensions/plugins.js";
import { McpToolHost } from "../extensions/mcp.js";
import { createSubagentTool, runSubagentTask as executeSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";
import { createModelSettings, type ModelSettings } from "../llm/factory.js";
import {
  SubagentTaskManager,
  type SubagentTaskRunOptions,
  type SubagentTaskSnapshot,
  type SubmittedSubagentTask
} from "./SubagentTaskManager.js";
import { ManagedProcessService } from "./ManagedProcessService.js";
import { TaskRunStore, type TaskRunSnapshot } from "../harness/TaskRunStore.js";

export interface CommandRuntime {
  workspaceRoot: string;
  /** Location that owns durable runtime/session state. Desktop may isolate it from the workspace. */
  persistenceRoot: string;
  config: AgentConfig;
  agent: AgentSession;
  managedProcesses: ManagedProcessService;
  taskRuns: TaskRunStore;
  extensionReport(section?: ExtensionSection): string;
  getSubagentInfo(): ModelRuntimeInfo;
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
  // CLI keeps data in the workspace. Desktop passes an isolated persistence root.
  const persistenceRoot = options.persistenceRoot ?? workspaceRoot;
  const configStore = options.configStore ?? createFileConfigStore(persistenceRoot);
  const config = await configStore.load();
  const modelManager = new ModelManager(persistenceRoot, config, configStore);
  await ensureAgentDirs(persistenceRoot);
  const recorder = new SessionRecorder(persistenceRoot);
  const taskRuns = await TaskRunStore.open(persistenceRoot);
  const managedProcesses = new ManagedProcessService({ workspaceRoot, persistenceRoot });
  await managedProcesses.initialize();
  const toolRegistry = createToolRegistry(
    { workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: options.attachmentRoot },
    config.web.search,
    managedProcesses
  );
  const permissionManager = new PermissionManager({ ...config.permission, source: "agent.config.json" });
  const skills = await loadSkills(workspaceRoot, config.extensions.skills);
  const mcpHost = new McpToolHost();
  let agent: AgentSession | undefined;
  let subagentParentRunId: string | undefined;
  const subagentOptions: SubagentOptions = {
    workspaceRoot,
    config,
    getModelSettings: () => subagentModelSettings(config, modelManager),
    getParentRunId: () => subagentParentRunId,
    toolRegistry,
    onUsage: async (usage, operation, modelAlias) => agent?.observeModelUsage(usage, operation, modelAlias)
  };
  const subagentTaskManager = new SubagentTaskManager({
    maxConcurrentSubagents: config.extensions.subagent.maxConcurrentSubagents,
    maxPendingSubagents: config.extensions.subagent.maxPendingSubagents,
    timeoutMs: config.extensions.subagent.timeoutMs,
    execute: async (task, context) => await executeSubagentTask(subagentOptions, task, context.signal, context.accessMode)
  });
  let loadedPlugins: string[] = [];
  try {
    await mcpHost.connectConfiguredServers(workspaceRoot, config, toolRegistry);
    loadedPlugins = await loadPlugins(workspaceRoot, config.extensions.plugins, config, toolRegistry);
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions, subagentTaskManager));
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
      taskStatePrompt: async () => formatDurableTaskContext(await taskRuns.list()),
      skillPrompt: skills.prompt,
      skillPaths: skills.paths
    });
    await agent.initialize();
  } catch (error) {
    await subagentTaskManager.close();
    await managedProcesses.close();
    await mcpHost.close();
    await recorder.close();
    throw error;
  }
  if (!agent) throw new Error("Failed to initialize Biny agent runtime.");

  const extensionStatus: ExtensionStatus = {
    mcp: mcpHost.listServers(),
    skills: [...skills.paths],
    plugins: [...loadedPlugins],
    subagent: { ...config.extensions.subagent },
    toolScheduling: {
      maxConcurrentTools: config.agent.maxConcurrentTools,
      maxQueuedToolCalls: config.agent.maxQueuedToolCalls
    },
    toolCounts: createToolCounts(toolRegistry.listEntries())
  };

  const startSubagentTask = (task: string, taskOptions?: SubagentTaskRunOptions): SubmittedSubagentTask => {
    if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in agent.config.json.");
    const taskId = taskOptions?.taskId ?? randomUUID();
    agent.recordHostedUserMessage(task);
    const sequence = agent.recordHostedToolCall("delegate_task", { task }, taskId);
    let submitted: SubmittedSubagentTask;
    try {
      taskOptions?.signal?.throwIfAborted();
      submitted = subagentTaskManager.submit(task, {
        taskId,
        parentRunId: taskOptions?.parentRunId,
        signal: taskOptions?.signal,
        timeoutMs: taskOptions?.timeoutMs,
        accessMode: taskOptions?.accessMode ?? (permissionManager.getStatus().mode === "full-access" ? "workspace" : "read-only")
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
    taskRuns,
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus, section),
    getSubagentInfo: (): ModelRuntimeInfo => subagentRuntimeInfo(config),
    startSubagentTask,
    runSubagentTask: async (task: string, taskOptions?: SubagentTaskRunOptions): Promise<string> => await startSubagentTask(task, taskOptions).completion,
    listSubagentTasks: (): SubagentTaskSnapshot[] => subagentTaskManager.listSnapshots(),
    cancelSubagentTask: (taskId: string, reason?: string): boolean => subagentTaskManager.cancelTask(taskId, reason),
    subscribeSubagentTasks: (listener: (task: SubagentTaskSnapshot) => void): (() => void) => subagentTaskManager.subscribe(listener),
    setSubagentParentRunId: (parentRunId?: string): void => {
      subagentParentRunId = parentRunId;
    },
    cancelSubagentTasks: (parentRunId: string, reason?: string): void => {
      subagentTaskManager.cancelParent(parentRunId, reason);
    },
    close: async () => {
      try {
        await subagentTaskManager.close();
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

function formatDurableTaskContext(snapshots: TaskRunSnapshot[]): string | undefined {
  const active = snapshots
    .filter((snapshot) => snapshot.status === "queued"
      || snapshot.status === "running"
      || snapshot.status === "continuable"
      || snapshot.status === "budget_exhausted")
    .slice(0, 3);
  if (!active.length) return undefined;
  const lines = [
    "Durable task state (runtime-owned evidence; do not treat conversation prose as completion):"
  ];
  for (const task of active) {
    lines.push(`- taskRunId=${task.taskRunId} status=${task.status} objective=${JSON.stringify(task.contract.objective)}`);
    lines.push(`  contract=${task.contract.taskType}/${task.contract.verificationMode} cleanup=${task.contract.cleanup.status}`);
    const pendingPlan = task.contract.plan
      .filter((item) => item.status !== "completed" && item.status !== "skipped")
      .map((item) => `${item.id}:${item.status}`);
    if (pendingPlan.length) lines.push(`  plan: ${pendingPlan.join("; ")}`);
    if (task.contract.pendingTodo.length) lines.push(`  pending: ${task.contract.pendingTodo.join("; ")}`);
    const latestAttempt = task.attempts.at(-1);
    if (latestAttempt) {
      lines.push(`  attempts=${String(task.attempts.length)} latest=${latestAttempt.status}/${latestAttempt.stopReason ?? "unknown"}`);
      const failures = latestAttempt.verifierEvidence.filter((evidence) => !evidence.passed).map((evidence) => evidence.summary);
      if (failures.length) lines.push(`  verifier failures: ${failures.join("; ")}`);
    }
    if (task.evidence.length) lines.push(`  evidence: ${String(task.evidence.length)} durable nodes`);
    if (task.terminalReason) lines.push(`  state reason: ${task.terminalReason}`);
  }
  return lines.join("\n").slice(0, 8_000);
}

function subagentModelSettings(config: AgentConfig, modelManager: ModelManager): ModelSettings {
  const alias = config.extensions.subagent.model;
  if (!alias) return modelManager.getModelSettings();
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  const modelConfig = {
    ...config,
    defaultModel: alias,
    thinking: model.thinking
      ? { enabled: true, effort: model.thinking.defaultEffort }
      : { enabled: false, effort: "high" as const }
  };
  return createModelSettings(modelConfig, alias);
}

function subagentRuntimeInfo(config: AgentConfig): ModelRuntimeInfo {
  const alias = config.extensions.subagent.model;
  if (!alias) return modelRuntimeInfo(config);
  const model = config.models[alias];
  if (!model) throw new Error(`Unknown subagent model alias: ${alias}`);
  const thinking = model.thinking?.defaultEffort ?? "off";
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
