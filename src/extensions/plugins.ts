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
  default?: ((context: BinyPluginContext) => void | Promise<void>) | { register?: (context: BinyPluginContext) => void | Promise<void>; tools?: Tool[] };
  register?: (context: BinyPluginContext) => void | Promise<void>;
  tools?: Tool[];
}

export async function loadPlugins(
  workspaceRoot: string,
  configuredPaths: string[],
  config: AgentConfig,
  registry: ToolRegistry
): Promise<string[]> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const files: string[] = [];
  const seen = new Set<string>();
  const collection = { files, seen, visited: 0 };
  for (const configuredPath of configuredPaths) {
    const target = await resolveWorkspacePluginPath(canonicalWorkspace, configuredPath);
    if (target) await collectPluginFiles(canonicalWorkspace, target, collection);
  }

  const loaded: string[] = [];
  const pluginConfig = configWithoutCredentials(config);
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    const imported = await import(pathToFileURL(filePath).href) as BinyPluginModule;
    const context: BinyPluginContext = {
      workspaceRoot: canonicalWorkspace,
      config: pluginConfig,
      registerTool: (tool) => registry.registerPluginTool(tool)
    };
    if (typeof imported.default === "function") await imported.default(context);
    if (typeof imported.register === "function") await imported.register(context);
    if (
      typeof imported.default === "object"
      && imported.default !== null
      && typeof imported.default.register === "function"
      && imported.default.register !== imported.register
    ) {
      await imported.default.register(context);
    }
    const exportedTools = [
      ...(Array.isArray(imported.tools) ? imported.tools : []),
      ...(typeof imported.default === "object" && imported.default !== null && Array.isArray(imported.default.tools) ? imported.default.tools : [])
    ];
    for (const tool of exportedTools) registry.registerPluginTool(tool);
    loaded.push(path.relative(canonicalWorkspace, filePath) || path.basename(filePath));
  }
  return loaded;
}

async function collectPluginFiles(
  workspaceRoot: string,
  target: string,
  collection: { files: string[]; seen: Set<string>; visited: number }
): Promise<void> {
  collection.visited += 1;
  if (collection.visited > 4_096) throw new Error("Plugin scan limit exceeded (4096 entries). Narrow extensions.plugins paths.");
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`Plugin paths cannot contain symbolic links: ${target}`);
  if (await escapesWorkspace(workspaceRoot, target)) throw new Error(`Plugin path escapes workspace: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1) throw new Error(`Plugin files cannot be hardlinks: ${target}`);
    if ([".js", ".mjs", ".cjs"].includes(path.extname(target).toLowerCase()) && !collection.seen.has(target)) {
      if (collection.files.length >= 64) throw new Error("Plugin file limit exceeded (64). Narrow extensions.plugins paths.");
      collection.seen.add(target);
      collection.files.push(target);
    }
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    await collectPluginFiles(workspaceRoot, path.join(target, entry.name), collection);
  }
}

async function resolveWorkspacePluginPath(workspaceRoot: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(workspaceRoot, configuredPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Plugin path must stay inside workspace: ${configuredPath}`);
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Plugin paths cannot be symbolic links: ${configuredPath}`);
    const canonical = await fs.realpath(absolutePath);
    if (path.relative(workspaceRoot, canonical).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(workspaceRoot, canonical))) {
      throw new Error(`Plugin path escapes workspace: ${configuredPath}`);
    }
    if (canonical !== absolutePath) throw new Error(`Plugin paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function configWithoutCredentials(config: AgentConfig): AgentConfig {
  const safe = structuredClone(config);
  for (const provider of Object.values(safe.providers)) {
    provider.apiKey = undefined;
    if (provider.oauth) provider.oauth.refreshToken = undefined;
  }
  for (const server of Object.values(safe.extensions.mcp)) server.env = undefined;
  return safe;
}

async function escapesWorkspace(workspaceRoot: string, target: string): Promise<boolean> {
  const canonical = await fs.realpath(target);
  const relative = path.relative(workspaceRoot, canonical);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
