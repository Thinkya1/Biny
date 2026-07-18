/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import { AgentSession } from "../agent/AgentSession.js";
import { ModelManager } from "../llm/ModelManager.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { loadSkills } from "../extensions/skills.js";
import { loadPlugins } from "../extensions/plugins.js";
import { McpToolHost } from "../extensions/mcp.js";
import { createSubagentTool, runSubagentTask, type SubagentOptions } from "../extensions/subagent.js";
import { createToolCounts, formatExtensionReport, type ExtensionSection, type ExtensionStatus } from "../extensions/report.js";

export interface CommandRuntime {
  workspaceRoot: string;
  agent: AgentSession;
  extensionReport(section?: ExtensionSection): string;
  runSubagentTask(task: string): Promise<string>;
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
  const toolRegistry = createToolRegistry({ workspaceRoot, ignore: config.workspace.ignore, attachmentRoot: options.attachmentRoot }, config.web.search);
  const permissionManager = new PermissionManager({ ...config.permission, source: "agent.config.json" });
  const skills = await loadSkills(workspaceRoot, config.extensions.skills);
  const mcpHost = new McpToolHost();
  const subagentOptions: SubagentOptions = {
    workspaceRoot,
    config,
    getModel: () => modelManager.getModel(),
    getModelSettings: () => modelManager.getModelSettings(),
    toolRegistry,
    onUsage: async (usage, operation) => agent?.observeModelUsage(usage, operation)
  };
  let agent: AgentSession | undefined;
  let loadedPlugins: string[] = [];
  try {
    await mcpHost.connectConfiguredServers(workspaceRoot, config, toolRegistry);
    loadedPlugins = await loadPlugins(workspaceRoot, config.extensions.plugins, config, toolRegistry);
    if (config.extensions.subagent.enabled) {
      toolRegistry.registerSubagentTool(createSubagentTool(subagentOptions));
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
      skillPaths: skills.paths
    });
    await agent.initialize();
  } catch (error) {
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
    toolCounts: createToolCounts(toolRegistry.listEntries())
  };

  const runtime: CommandRuntime = {
    workspaceRoot,
    agent,
    extensionReport: (section?: ExtensionSection): string => formatExtensionReport(extensionStatus, section),
    runSubagentTask: async (task: string): Promise<string> => {
      if (!config.extensions.subagent.enabled) throw new Error("Subagent extension is disabled in agent.config.json.");
      return await runSubagentTask(subagentOptions, task);
    },
    close: async () => {
      try {
        await agent.close();
      } finally {
        await mcpHost.close();
      }
    }
  };
  return runtime;
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
