/**
 * 从自然语言目标推断任务契约。
 *
 * 两步：先按关键词判断任务类型（启动服务 / 改代码 / 纯对话），再扫描工作区里的 pom.xml、
 * package.json，把能机器校验的东西编译成验收条件（构建、测试、typecheck、进程就绪探针）。
 *
 * 判定用中英文关键词表，是有意保守的启发式：识别不出就退回 `conversation` + 仅模型验收，
 * 也就是回到普通对话的行为；宁可少判成项目任务，也不要给对话类问题套上一堆跑不通的检查。
 */
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { compileTaskContract } from "./TaskContractCompiler.js";
import type { AcceptanceCriterion, TaskContract } from "./types.js";
import { workspaceStateDigest } from "./WorkspaceState.js";

const ignoredDirectoryNames = new Set([".agent", ".git", "node_modules", "dist", "build", "out", "target", "coverage"]);
const launchIntentPattern = /(?:启动|运行起来|跑起来|启动服务|start\s+(?:the\s+)?(?:project|app|server|service)|run\s+(?:the\s+)?(?:project|app|server|service)|serve\s+(?:the\s+)?(?:project|app))/iu;
const codeChangeIntentPattern = /(?:修改|改动|更改|实现|修复|增加|添加|删除|重构|编写|更新|替换|迁移|优化|开发|补全|完善|复制|移动|重命名|排序|去重|转换|解析|生成|清理|规范化|合并|导出|导入|提取|保留|实现一下|implement|fix|add|remove|refactor|update|change|create|write|modify|improve|complete|copy|move|rename|sort|deduplicate|convert|parse|generate|clean|normalize|merge|export|import|extract)/iu;
const negatedCodeChangeIntentPattern = /(?:(?:不(?:要|必)?|无需|不需要|禁止|切勿)\s*(?:去\s*)?|(?:do\s+not|don't|without|no)\s+)(?:修改|改动|更改|实现|修复|增加|添加|删除|重构|编写|更新|替换|迁移|优化|开发|补全|完善|复制|移动|重命名|排序|去重|转换|解析|生成|清理|规范化|合并|导出|导入|提取|保留|implement|fix|add|remove|refactor|update|change|create|write|modify|improve|complete|copy|move|rename|sort|deduplicate|convert|parse|generate|clean|normalize|merge|export|import|extract)/igu;
const fileReferencePattern = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/gu;

/** 为项目型任务编译确定性验收条件；对话型任务只做模型验收。 */
export async function createTaskContract(workspaceRoot: string, objective: string, ignore: string[] = []): Promise<TaskContract> {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("Task objective cannot be empty.");
  const isLaunchTask = launchIntentPattern.test(trimmed);
  // 判断「是否要改代码」前先剔除两类干扰：否定说法（"不要修改…"）和文件名
  // （`update.ts` 里的 update 不是动词），否则一句「看一下 update.ts，别改」会被判成改代码任务。
  const codeChangeIntent = trimmed.replace(negatedCodeChangeIntentPattern, "").replace(fileReferencePattern, " ");
  const isCodeTask = !isLaunchTask && codeChangeIntentPattern.test(codeChangeIntent);
  if (!isLaunchTask && !isCodeTask) {
    return compileTaskContract({
      objective: trimmed,
      taskType: "conversation",
      acceptanceCriteria: [],
      verificationMode: "model_only"
    });
  }

  const manifests = await discoverFiles(workspaceRoot, new Set(["pom.xml", "package.json"]), 3, 2_000);
  const criteria: AcceptanceCriterion[] = [];
  const pendingTodo: string[] = [];
  const mavenProjects = manifests.filter((filePath) => path.basename(filePath) === "pom.xml");
  const nodeProjects: NodeProject[] = [];

  // 基线指纹必须在任务开始前算，之后才能证明这次尝试确实动过工作区。
  if (isCodeTask) {
    criteria.push({
      id: "workspace-changed",
      kind: "workspace_changed",
      baselineDigest: await workspaceStateDigest(workspaceRoot, ignore),
      description: "Workspace content changed for the requested code task"
    });
  }

  for (const manifestPath of manifests) {
    const relative = toRelative(workspaceRoot, manifestPath);
    criteria.push({
      id: criterionId("file", relative),
      kind: "file_exists",
      path: relative,
      description: `Required project file ${relative}`
    });
    if (path.basename(manifestPath) !== "package.json") continue;
    const project = await readNodeProject(manifestPath, workspaceRoot);
    if (project) nodeProjects.push(project);
  }

  for (const pomPath of mavenProjects) {
    const cwd = toRelative(workspaceRoot, path.dirname(pomPath));
    criteria.push({
      id: criterionId("maven-test", cwd),
      kind: "command_succeeded",
      command: await mavenTestCommand(path.dirname(pomPath)),
      cwd,
      description: `Maven tests in ${cwd}`
    });
    if (isLaunchTask) {
      criteria.push({
        id: criterionId("backend-process", cwd),
        kind: "managed_process",
        cwd,
        requireHttpReadiness: true,
        description: `Backend service in ${cwd}`
      });
      pendingTodo.push(`Keep the backend in ${cwd} managed and HTTP-ready.`);
    }
  }

  for (const project of nodeProjects) {
    const cwd = toRelative(workspaceRoot, project.directory);
    if (project.scripts.has("build") && (isLaunchTask || isCodeTask)) {
      criteria.push({
        id: criterionId("node-build", cwd),
        kind: "command_succeeded",
        command: packageScriptCommand(project.packageManager, "build"),
        cwd,
        description: `Frontend build in ${cwd}`
      });
    }
    if (project.scripts.has("test") && !isPlaceholderTest(project.scripts.get("test"))) {
      criteria.push({
        id: criterionId("node-test", cwd),
        kind: "command_succeeded",
        command: packageScriptCommand(project.packageManager, "test"),
        cwd,
        description: `Frontend tests in ${cwd}`
      });
    }
    if (isCodeTask) {
      for (const script of ["typecheck", "lint"]) {
        if (!project.scripts.has(script)) continue;
        criteria.push({
          id: criterionId(`node-${script}`, cwd),
          kind: "command_succeeded",
          command: packageScriptCommand(project.packageManager, script),
          cwd,
          description: `${script} in ${cwd}`
        });
      }
    }
    if (isLaunchTask && project.isFrontend) {
      criteria.push({
        id: criterionId("frontend-process", cwd),
        kind: "managed_process",
        cwd,
        requireHttpReadiness: true,
        description: `Frontend service in ${cwd}`
      });
      pendingTodo.push(`Keep the frontend in ${cwd} managed and HTTP-ready.`);
    }
  }

  const backend = mavenProjects[0] ? await inferJavaService(workspaceRoot, path.dirname(mavenProjects[0])) : undefined;
  const frontendProject = nodeProjects.find((project) => project.isFrontend);
  const frontend = frontendProject ? await inferFrontendService(frontendProject.directory) : undefined;
  if (backend?.route) {
    criteria.push({
      id: "backend-http-readiness",
      kind: "http",
      url: `http://127.0.0.1:${String(backend.port)}${backend.route}`,
      expectedStatus: 200,
      description: "Backend HTTP readiness"
    });
  }
  if (frontend) {
    criteria.push({
      id: "frontend-http-readiness",
      kind: "http",
      url: `http://127.0.0.1:${String(frontend.port)}/`,
      expectedStatus: 200,
      description: "Frontend HTTP readiness"
    });
  }
  if (frontend?.proxyPrefix && backend?.route && backend.route.startsWith(frontend.proxyPrefix)) {
    criteria.push({
      id: "frontend-proxy-api",
      kind: "http",
      url: `http://127.0.0.1:${String(frontend.port)}${backend.route}`,
      expectedStatus: 200,
      description: "Frontend proxy API"
    });
    pendingTodo.push("Verify the frontend proxy reaches a backend API with HTTP 200.");
  }

  const acceptanceCriteria = deduplicateCriteria(criteria);
  const taskType = isLaunchTask ? "launch" : "code_change";
  return compileTaskContract({
    objective: trimmed,
    taskType,
    acceptanceCriteria,
    verificationMode: "deterministic",
    artifacts: manifests.map((manifestPath) => toRelative(workspaceRoot, manifestPath)),
    pendingTodo
  });
}

interface NodeProject {
  directory: string;
  scripts: Map<string, string>;
  isFrontend: boolean;
  packageManager: PackageManager;
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/**
 * 读取一个 Node 项目的信息。package.json 读不到或格式不对就返回 undefined——推断失败只是
 * 少生成几条验收条件，不该让整个任务起不来。
 */
async function readNodeProject(manifestPath: string, workspaceRoot: string): Promise<NodeProject | undefined> {
  try {
    const text = await readBoundedText(manifestPath, 512 * 1024);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const scripts = new Map<string, string>();
    if (isRecord(parsed.scripts)) {
      for (const [name, command] of Object.entries(parsed.scripts)) {
        if (typeof command === "string") scripts.set(name, command);
      }
    }
    const dependencies = {
      ...(isRecord(parsed.dependencies) ? parsed.dependencies : {}),
      ...(isRecord(parsed.devDependencies) ? parsed.devDependencies : {})
    };
    const directory = path.dirname(manifestPath);
    const hasViteConfig = await firstExisting(directory, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs",
      "vite.config.cjs"
    ]) !== undefined;
    return {
      directory,
      scripts,
      // 前端判定看三处：有 vite 配置文件、依赖里有前端框架、或 dev 脚本用的是前端工具链。
      isFrontend: hasViteConfig
        || "vite" in dependencies
        || "react" in dependencies
        || "vue" in dependencies
        || "@angular/core" in dependencies
        || scripts.has("dev") && /vite|next|nuxt|webpack|react-scripts/iu.test(scripts.get("dev") ?? ""),
      packageManager: await detectPackageManager(directory, workspaceRoot)
    };
  } catch {
    return undefined;
  }
}

async function mavenTestCommand(directory: string): Promise<string> {
  return (await firstExisting(directory, ["mvnw"])) ? "./mvnw test" : "mvn test";
}

/**
 * 按 lock 文件判断包管理器。子包目录里通常没有 lock 文件（monorepo 只在仓库根有一份），
 * 所以找不到时回到工作区根再判一次，最后兜底 npm。
 */
async function detectPackageManager(directory: string, workspaceRoot: string): Promise<PackageManager> {
  if (await firstExisting(directory, ["pnpm-lock.yaml"])) return "pnpm";
  if (await firstExisting(directory, ["yarn.lock"])) return "yarn";
  if (await firstExisting(directory, ["bun.lockb", "bun.lock"])) return "bun";
  const root = path.resolve(workspaceRoot);
  if (path.resolve(directory) !== root) return await detectPackageManager(root, root);
  return "npm";
}

function packageScriptCommand(packageManager: PackageManager, script: string): string {
  return `${packageManager} run ${script}`;
}

/**
 * 从 vite 配置里抠出端口和代理前缀，用来生成前端就绪探针。用正则而不是执行配置文件：
 * 配置是 TS/JS 代码，跑它等于执行工作区里的任意代码。抠不到就用 vite 默认端口 5173。
 */
async function inferFrontendService(directory: string): Promise<{ port: number; proxyPrefix?: string }> {
  const configPath = await firstExisting(directory, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
    "vite.config.mjs",
    "vite.config.cjs"
  ]);
  if (!configPath) return { port: 5173 };
  const text = await readBoundedText(configPath, 512 * 1024).catch(() => "");
  const port = Number(text.match(/\bport\s*:\s*(\d{2,5})\b/u)?.[1] ?? 5173);
  const proxyBlock = text.match(/\bproxy\s*:\s*\{([\s\S]{0,10000}?)\n\s*\}/u)?.[1] ?? "";
  const proxyPrefix = proxyBlock.match(/["'](\/[^"']*)["']\s*:/u)?.[1];
  return { port: validPort(port) ? port : 5173, proxyPrefix };
}

/**
 * 推断 Spring 服务的端口和一个可探测的 GET 路由：端口从 application.properties/yml 读，
 * 路由从带 `@RestController` + `@GetMapping` 的类里取「类级 RequestMapping + 方法级 GetMapping」
 * 拼成。带路径参数（`{id}`）的路由不能直接请求，会被 `normalizeRoute` 排除。
 */
async function inferJavaService(
  workspaceRoot: string,
  directory: string
): Promise<{ port: number; route?: string }> {
  const propertyFiles = await discoverFiles(directory, new Set(["application.properties", "application.yml", "application.yaml"]), 6, 1_000);
  let port = 8080;
  for (const propertyFile of propertyFiles) {
    const text = await readBoundedText(propertyFile, 256 * 1024).catch(() => "");
    const candidate = Number(
      text.match(/^\s*server\.port\s*=\s*(\d{2,5})\s*$/mu)?.[1]
      ?? text.match(/^\s*port\s*:\s*(\d{2,5})\s*$/mu)?.[1]
    );
    if (validPort(candidate)) {
      port = candidate;
      break;
    }
  }

  const javaFiles = await discoverByExtension(path.join(directory, "src", "main", "java"), ".java", 12, 2_000);
  for (const javaFile of javaFiles) {
    const text = await readBoundedText(javaFile, 512 * 1024).catch(() => "");
    if (!/@(?:RestController|Controller)\b/u.test(text) || !/@GetMapping\b/u.test(text)) continue;
    const classIndex = text.search(/\bclass\s+\w+/u);
    const classPrefix = classIndex >= 0 ? text.slice(0, classIndex) : text;
    const base = mappingPath(classPrefix, "RequestMapping") ?? "";
    const method = mappingPath(classIndex >= 0 ? text.slice(classIndex) : text, "GetMapping") ?? "";
    const route = normalizeRoute(`${base}/${method}`);
    if (route) return { port, route };
  }
  void workspaceRoot;
  return { port };
}

function mappingPath(text: string, annotation: string): string | undefined {
  const expression = new RegExp(`@${annotation}\\s*(?:\\(\\s*(?:value\\s*=\\s*)?["']([^"']*)["'][^)]*\\))?`, "u");
  const match = text.match(expression);
  if (!match) return undefined;
  return match[1] ?? "";
}

function normalizeRoute(value: string): string | undefined {
  const route = `/${value}`.replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
  if (!route || route === "/" || /\{|\}/u.test(route)) return undefined;
  return route;
}

async function discoverFiles(
  root: string,
  names: ReadonlySet<string>,
  maxDepth: number,
  maxEntries: number
): Promise<string[]> {
  return await walk(root, maxDepth, maxEntries, (entry) => entry.isFile() && names.has(entry.name));
}

async function discoverByExtension(
  root: string,
  extension: string,
  maxDepth: number,
  maxEntries: number
): Promise<string[]> {
  return await walk(root, maxDepth, maxEntries, (entry) => entry.isFile() && entry.name.endsWith(extension));
}

/**
 * 有界目录遍历：限深度、限条目数、跳过符号链接和构建目录，读不了的目录直接跳过。
 * 结果排序后返回，保证同一个工作区每次生成的验收条件顺序一致。
 */
async function walk(
  root: string,
  maxDepth: number,
  maxEntries: number,
  matches: (entry: Dirent) => boolean
): Promise<string[]> {
  const results: string[] = [];
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return;
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(directory, entry.name);
      if (matches(entry)) results.push(filePath);
      if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name)) await visit(filePath, depth + 1);
    }
  };
  await visit(path.resolve(root), 0);
  return results.sort();
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`File is not a bounded regular file: ${filePath}`);
  return await fs.readFile(filePath, "utf8");
}

async function firstExisting(directory: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // 文件不存在，试下一个惯用名。
    }
  }
  return undefined;
}

function deduplicateCriteria(criteria: AcceptanceCriterion[]): AcceptanceCriterion[] {
  const seen = new Set<string>();
  return criteria.filter((criterion) => {
    if (seen.has(criterion.id)) return false;
    seen.add(criterion.id);
    return true;
  });
}

/** 用路径拼稳定的条件 id：非法字符换成连字符，空路径（工作区根）记作 root。 */
function criterionId(prefix: string, value: string): string {
  const suffix = value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "root";
  return `${prefix}-${suffix}`.slice(0, 128);
}

/** `npm init` 生成的占位 test 脚本必然失败，不能当成验收条件。 */
function isPlaceholderTest(command: string | undefined): boolean {
  return !command || /no test specified|exit\s+1/iu.test(command);
}

function toRelative(root: string, value: string): string {
  return path.relative(path.resolve(root), path.resolve(value)) || ".";
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
