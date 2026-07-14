import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentConfig } from "../config/schema.js";
import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface BinyPluginContext {
  workspaceRoot: string;
  config: AgentConfig;
  registerTool(tool: Tool): void;
}

interface BinyPluginModule {
  default?: ((context: BinyPluginContext) => void | Promise<void>) | { tools?: Tool[] };
  register?: (context: BinyPluginContext) => void | Promise<void>;
  tools?: Tool[];
}

export async function loadPlugins(
  workspaceRoot: string,
  configuredPaths: string[],
  config: AgentConfig,
  registry: ToolRegistry
): Promise<string[]> {
  const files: string[] = [];
  for (const configuredPath of configuredPaths) await collectPluginFiles(resolveWorkspacePath(workspaceRoot, configuredPath), files);

  const loaded: string[] = [];
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    const imported = await import(pathToFileURL(filePath).href) as BinyPluginModule;
    const context: BinyPluginContext = {
      workspaceRoot,
      config,
      registerTool: (tool) => registry.registerPluginTool(tool)
    };
    if (typeof imported.default === "function") await imported.default(context);
    if (typeof imported.register === "function") await imported.register(context);
    const exportedTools = [
      ...(Array.isArray(imported.tools) ? imported.tools : []),
      ...(typeof imported.default === "object" && imported.default !== null && Array.isArray(imported.default.tools) ? imported.default.tools : [])
    ];
    for (const tool of exportedTools) registry.registerPluginTool(tool);
    loaded.push(path.relative(workspaceRoot, filePath) || path.basename(filePath));
  }
  return loaded;
}

async function collectPluginFiles(target: string | undefined, files: string[]): Promise<void> {
  if (!target) return;
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if ([".js", ".mjs", ".cjs"].includes(path.extname(target).toLowerCase())) files.push(target);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    await collectPluginFiles(path.join(target, entry.name), files);
  }
}

function resolveWorkspacePath(workspaceRoot: string, configuredPath: string): string | undefined {
  const absolutePath = path.resolve(workspaceRoot, configuredPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? absolutePath : undefined;
}
