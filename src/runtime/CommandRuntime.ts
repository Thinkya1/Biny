/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一个 AgentSession。这里是 composition
 * root，只装配配置、provider、工具和权限，不向宿主泄露可变 conversation 或 recorder。
 */
import { loadConfig } from "../config/loader.js";
import { AgentSession } from "../agent/AgentSession.js";
import { ModelManager } from "../llm/ModelManager.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permission/PermissionManager.js";

export interface CommandRuntime {
  workspaceRoot: string;
  agent: AgentSession;
  close(): Promise<void>;
}

export async function createCommandRuntime(workspaceRoot: string): Promise<CommandRuntime> {
  // 每次命令执行都在同一位置装配配置、session、provider、工具、权限和核心 Agent。
  const config = await loadConfig(workspaceRoot);
  const modelManager = new ModelManager(workspaceRoot, config);
  await ensureAgentDirs(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const toolRegistry = createToolRegistry({ workspaceRoot, ignore: config.workspace.ignore });
  const permissionManager = new PermissionManager({ ...config.permission, source: "agent.config.json" });
  const agent = new AgentSession({
    workspaceRoot,
    config,
    model: modelManager.getModel(),
    modelManager,
    toolRegistry,
    permissionManager,
    recorder
  });
  await agent.initialize();

  const runtime: CommandRuntime = {
    workspaceRoot,
    agent,
    close: async () => await agent.close()
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
