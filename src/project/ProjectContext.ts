/**
 * 项目上下文摘要模块。
 *
 * 运行时启动时会从这里收集轻量项目信息：包管理器、package 脚本和依赖名、tsconfig、README、
 * `src` 目录轮廓以及 git 状态。它刻意不读取完整源码，目的是给模型足够方向而不撑大上下文。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isIgnoredPath } from "../workspace/ignore.js";
import { pathExists } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

export interface ProjectContext {
  // ProjectContext 是发送给模型的轻量项目摘要，不应包含完整源码。
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
  // 格式化输出保持纯文本，便于直接拼进 prompt，也方便调试时阅读。
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
  // 通过 lockfile 推断包管理器，优先级按项目中常见的显式锁文件排列。
  if (await pathExists(path.join(workspaceRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(workspaceRoot, "yarn.lock"))) return "yarn";
  if (await pathExists(path.join(workspaceRoot, "package-lock.json"))) return "npm";
  if (await pathExists(path.join(workspaceRoot, "bun.lockb"))) return "bun";
  return "unknown";
}

async function readPackageJsonSummary(workspaceRoot: string): Promise<PackageJsonSummary | undefined> {
  // package.json 只提取脚本和依赖名，不把完整版本约束放进上下文。
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
  // tsconfig 摘要保留 compilerOptions，帮助模型判断模块系统和 JSX 配置。
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
  // 文本文档摘要只截断，不做解析；README 内容通常足够说明项目用途。
  if (!(await pathExists(filePath))) return undefined;
  const content = await fs.readFile(filePath, "utf8");
  return content.slice(0, maxChars);
}

async function readSrcTree(workspaceRoot: string, ignore: string[], limit: number): Promise<string[]> {
  // src tree 用来提供目录轮廓，限制深度和数量以保护大型仓库。
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
  // git status 失败时不阻断启动；非仓库目录仍可使用文件和命令工具。
  try {
    const result = await execFileAsync("git", ["status", "--short"], { cwd: workspaceRoot, timeout: 10_000 });
    return result.stdout.trim();
  } catch {
    return "(not a git repository)";
  }
}

function stringValue(value: unknown): string | undefined {
  // JSON 字段类型不可信，所有摘要字段都先做类型收窄。
  return typeof value === "string" ? value : undefined;
}

function objectKeys(value: unknown): string[] {
  // 依赖和脚本只需要键名，并排序保证 prompt 稳定。
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 排除数组，避免把数组下标当成对象键名。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
