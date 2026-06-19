import type { Tool, ToolContext } from "./types.js";
import { createReadFileTool } from "./file/readFile.js";
import { createWriteFileTool } from "./file/writeFile.js";
import { createEditFileTool } from "./file/editFile.js";
import { createListFilesTool } from "./file/listFiles.js";
import { createSearchFilesTool } from "./search/searchFiles.js";
import { createRunCommandTool } from "./shell/runCommand.js";

export type ToolSource = "builtin" | "mcp" | "skill" | "plugin";

export interface RegisteredTool {
  source: ToolSource;
  tool: Tool;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool, source: ToolSource = "builtin"): void {
    // source 用来给未来 MCP、skill、plugin 工具留来源信息；当前内置工具默认是 builtin。
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { source, tool });
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

  listEntries(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}

export function createToolRegistry(context: ToolContext): ToolRegistry {
  // 这里集中注册内置工具。后续接入 MCP/skill/plugin 时，不要改工具调用方，只扩展 registry 来源。
  const registry = new ToolRegistry();
  registry.register(createReadFileTool(context));
  registry.register(createListFilesTool(context));
  registry.register(createSearchFilesTool(context));
  registry.register(createWriteFileTool(context));
  registry.register(createEditFileTool(context));
  registry.register(createRunCommandTool(context));
  return registry;
}
