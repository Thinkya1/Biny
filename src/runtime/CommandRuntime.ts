import { loadConfig } from "../config/loader.js";
import type { AgentConfig } from "../config/schema.js";
import { MockProvider } from "../llm/mock.js";
import type { LLMProvider } from "../llm/provider.js";
import { collectProjectContext, type ProjectContext } from "../project/ProjectContext.js";
import { SessionRecorder } from "../session/recorder.js";
import { ensureAgentDirs } from "../session/store.js";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.js";

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
  close(): Promise<void>;
}

export async function createCommandRuntime(workspaceRoot: string): Promise<CommandRuntime> {
  // 每次命令执行都创建一套运行时上下文：配置、session、provider、项目摘要和工具注册表。
  // 这样 run/chat/plan 的启动流程保持一致，后续扩展也只需要改这里。
  await ensureAgentDirs(workspaceRoot);
  const config = await loadConfig(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const llm = new MockProvider();
  const projectContext = await collectProjectContext(workspaceRoot, config.workspace.ignore);
  const toolRegistry = createToolRegistry({ workspaceRoot, ignore: config.workspace.ignore });

  return {
    workspaceRoot,
    config,
    recorder,
    llm,
    projectContext,
    toolRegistry,
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
