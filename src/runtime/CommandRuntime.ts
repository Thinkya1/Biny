/**
 * 命令运行时装配模块。
 *
 * 每个 CLI/TUI 入口最终都会通过这里创建一套共享运行时：配置、模型 provider、
 * session recorder、项目摘要和工具注册表。这样上层命令不需要重复初始化逻辑，
 * 未来接入 MCP、skill、memory 等能力也可以继续从这个运行时扩展。
 */
import { loadConfig } from "../config/loader.js";
import type { AgentConfig } from "../config/schema.js";
import { createLLMProvider } from "../llm/factory.js";
import type { ChatMessage, LLMProvider } from "../llm/provider.js";
import { collectProjectContext, type ProjectContext } from "../project/ProjectContext.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.js";
import { PermissionManager } from "../permission/PermissionManager.js";

export interface FutureRuntimeExtensions {
  // 这些字段当前只是占位，目的是让后续 MCP、skill、subagent、memory 等能力通过 Runtime 注入，
  // 不要再把初始化逻辑分散到各个 CLI command 里。
  mcpRegistry?: unknown;
  skillRegistry?: unknown;
  subagentRegistry?: unknown;
  memoryStore?: unknown;
  contextAssembler?: unknown;
}

export interface CommandRuntime extends FutureRuntimeExtensions {
  workspaceRoot: string;
  config: AgentConfig;
  recorder: SessionRecorder;
  llm: LLMProvider;
  projectContext: ProjectContext;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  conversation: ChatMessage[];
  close(): Promise<void>;
}

export async function createCommandRuntime(workspaceRoot: string): Promise<CommandRuntime> {
  // 每次命令执行都创建一套运行时上下文：配置、session、provider、项目摘要和工具注册表。
  // 这样 run/chat/plan 的启动流程保持一致，后续扩展也只需要改这里。
  await ensureAgentDirs(workspaceRoot);
  const config = await loadConfig(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const llm = createLLMProvider(config);
  const projectContext = await collectProjectContext(workspaceRoot, config.workspace.ignore);
  const toolRegistry = createToolRegistry({ workspaceRoot, ignore: config.workspace.ignore });
  const permissionManager = new PermissionManager({ ...config.permission, source: "agent.config.json" });
  const conversation: ChatMessage[] = [];

  return {
    workspaceRoot,
    config,
    recorder,
    llm,
    projectContext,
    toolRegistry,
    permissionManager,
    conversation,
    close: () => recorder.close()
  };
}

export async function withCommandRuntime(workspaceRoot: string, fn: (runtime: CommandRuntime) => Promise<void>): Promise<void> {
  const runtime = await createCommandRuntime(workspaceRoot);
  try {
    await fn(runtime);
  } catch (error) {
    // 命令层的异常统一落到 session，方便 resume 时看到失败原因。
    runtime.recorder.record({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await runtime.close();
  }
}
