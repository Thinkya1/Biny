/**
 * 工具注册表模块。
 *
 * 内置文件、搜索和命令工具会在这里集中注册，agent loop 通过名称查找并执行工具。注册表也保留
 * 工具来源信息，后续 MCP、skill 或 plugin 工具接入时可以复用同一调用路径。
 */
import type { JsonObjectSchema } from "./schema.js";
import type { ToolDefinition } from "./definition.js";
import type { Tool, ToolContext, ToolExecution, ToolSource } from "./types.js";
import { createReadFileTool } from "./file/readFile.js";
import { createWriteFileTool } from "./file/writeFile.js";
import { createEditFileTool } from "./file/editFile.js";
import { createListFilesTool } from "./file/listFiles.js";
import { createSearchFilesTool } from "./search/searchFiles.js";
import { createGrepSearchTool } from "./search/grepSearch.js";
import { createRunCommandTool } from "./shell/runCommand.js";
import { createGitStatusTool } from "./git/status.js";
import { createGitDiffTool } from "./git/diff.js";

export interface RegisteredTool {
  source: ToolSource;
  tool: Tool;
}

export class ToolManager {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool | LegacyTool, source: ToolSource = "builtin"): void {
    // source 用来给未来 MCP、skill、plugin 工具留来源信息；当前内置工具默认是 builtin。
    const normalized = normalizeTool(tool);
    if (this.tools.has(normalized.name)) {
      throw new Error(`Tool already registered: ${normalized.name}`);
    }
    this.tools.set(normalized.name, { source, tool: normalized });
  }

  registerBuiltinTool(tool: Tool): void {
    this.register(tool, "builtin");
  }

  registerUserTool(tool: Tool): void {
    this.register(tool, "skill");
  }

  registerMcpTool(tool: Tool): void {
    this.register(tool, "mcp");
  }

  get<TArgs = unknown, TResult = unknown>(name: string): Tool<TArgs, TResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return entry.tool as Tool<TArgs, TResult>;
  }

  list(): Tool[] {
    return [...this.tools.values()].map((entry) => entry.tool);
  }

  listDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  listEntries(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}

export class ToolRegistry extends ToolManager {}

export function createToolRegistry(context: ToolContext): ToolRegistry {
  // 这里集中注册内置工具。后续接入 MCP/skill/plugin 时，不要改工具调用方，只扩展 registry 来源。
  const registry = new ToolRegistry();
  registry.register(createReadFileTool(context));
  registry.register(createListFilesTool(context));
  registry.register(createSearchFilesTool(context));
  registry.register(createGrepSearchTool(context));
  registry.register(createGitStatusTool(context));
  registry.register(createGitDiffTool(context));
  registry.register(createWriteFileTool(context));
  registry.register(createEditFileTool(context));
  registry.register(createRunCommandTool(context));
  return registry;
}

interface LegacyTool<TArgs = unknown, TResult = unknown> extends Omit<Tool<TArgs, TResult>, "parameters" | "resolveExecution"> {
  parameters?: JsonObjectSchema;
  execute(args: TArgs): Promise<TResult>;
}

function normalizeTool(tool: Tool | LegacyTool): Tool {
  if ("resolveExecution" in tool && typeof tool.resolveExecution === "function") return tool;
  const legacy = tool as LegacyTool;
  return {
    name: legacy.name,
    description: legacy.description,
    parameters: legacy.parameters ?? { type: "object", additionalProperties: true },
    schema: legacy.schema,
    source: legacy.source,
    capability: legacy.capability,
    risk: legacy.risk,
    resolveExecution(args: unknown): ToolExecution {
      return {
        approvalRule: legacy.name,
        async execute() {
          return await legacy.execute(args);
        }
      };
    }
  };
}
