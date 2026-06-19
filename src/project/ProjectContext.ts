import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isIgnoredPath } from "../workspace/ignore.js";
import { pathExists } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

export interface ProjectContext {
  cwd: string;
  packageManager: string;
  packageJson?: PackageJsonSummary;
  tsconfig?: TsconfigSummary;
  readme?: string;
  srcTree: string[];
  gitStatus: string;
}

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  type?: string;
  scripts: string[];
  dependencies: string[];
  devDependencies: string[];
}

export interface TsconfigSummary {
  compilerOptions: Record<string, unknown>;
  include?: unknown;
  exclude?: unknown;
}

export async function collectProjectContext(workspaceRoot: string, ignore: string[]): Promise<ProjectContext> {
  // ProjectContext 只收集摘要，不读取整个项目。这样启动 chat/run 时足够快，
  // 也避免把大量源码直接塞进上下文。
  const [packageManager, packageJson, tsconfig, readme, srcTree, gitStatus] = await Promise.all([
    detectPackageManager(workspaceRoot),
    readPackageJsonSummary(workspaceRoot),
    readTsconfigSummary(workspaceRoot),
    readTextSummary(path.join(workspaceRoot, "README.md"), 3000),
    readSrcTree(workspaceRoot, ignore, 120),
    readGitStatus(workspaceRoot)
  ]);

  return {
    cwd: workspaceRoot,
    packageManager,
    packageJson,
    tsconfig,
    readme,
    srcTree,
    gitStatus
  };
}

export function formatProjectContext(context: ProjectContext): string {
  return [
    `cwd: ${context.cwd}`,
    `packageManager: ${context.packageManager}`,
    context.packageJson ? `package.json: ${JSON.stringify(context.packageJson, null, 2)}` : "package.json: (missing)",
    context.tsconfig ? `tsconfig.json: ${JSON.stringify(context.tsconfig, null, 2)}` : "tsconfig.json: (missing)",
    `README.md:\n${context.readme ?? "(missing)"}`,
    `src tree:\n${context.srcTree.length ? context.srcTree.join("\n") : "(missing or empty)"}`,
    `git status:\n${context.gitStatus || "(clean)"}`
  ].join("\n\n");
}

async function detectPackageManager(workspaceRoot: string): Promise<string> {
  if (await pathExists(path.join(workspaceRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(workspaceRoot, "yarn.lock"))) return "yarn";
  if (await pathExists(path.join(workspaceRoot, "package-lock.json"))) return "npm";
  if (await pathExists(path.join(workspaceRoot, "bun.lockb"))) return "bun";
  return "unknown";
}

async function readPackageJsonSummary(workspaceRoot: string): Promise<PackageJsonSummary | undefined> {
  const filePath = path.join(workspaceRoot, "package.json");
  if (!(await pathExists(filePath))) return undefined;
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  return {
    name: stringValue(value.name),
    version: stringValue(value.version),
    type: stringValue(value.type),
    scripts: objectKeys(value.scripts),
    dependencies: objectKeys(value.dependencies),
    devDependencies: objectKeys(value.devDependencies)
  };
}

async function readTsconfigSummary(workspaceRoot: string): Promise<TsconfigSummary | undefined> {
  const filePath = path.join(workspaceRoot, "tsconfig.json");
  if (!(await pathExists(filePath))) return undefined;
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  const compilerOptions = isRecord(value.compilerOptions) ? value.compilerOptions : {};
  return {
    compilerOptions,
    include: value.include,
    exclude: value.exclude
  };
}

async function readTextSummary(filePath: string, maxChars: number): Promise<string | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  const content = await fs.readFile(filePath, "utf8");
  return content.slice(0, maxChars);
}

async function readSrcTree(workspaceRoot: string, ignore: string[], limit: number): Promise<string[]> {
  const srcRoot = path.join(workspaceRoot, "src");
  if (!(await pathExists(srcRoot))) return [];
  const entries: string[] = [];
  await walk(srcRoot, "src", 0);
  return entries;

  async function walk(currentDir: string, relativeDir: string, depth: number): Promise<void> {
    // 目录树只保留有限深度和数量，避免大型仓库启动时扫描过多文件。
    if (entries.length >= limit || depth > 6) return;
    const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      if (entries.length >= limit) return;
      const relativePath = path.join(relativeDir, entry.name);
      if (isIgnoredPath(relativePath, ignore)) continue;
      entries.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "[d] " : "[f] "}${relativePath}`);
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relativePath, depth + 1);
      }
    }
  }
}

async function readGitStatus(workspaceRoot: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["status", "--short"], { cwd: workspaceRoot, timeout: 10_000 });
    return result.stdout.trim();
  } catch {
    return "(not a git repository)";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
