import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type { AcceptanceCriterion, TaskRequest } from "./types.js";

const ignoredDirectoryNames = new Set([".agent", ".git", "node_modules", "dist", "build", "out", "target", "coverage"]);
const launchIntentPattern = /(?:启动|运行起来|跑起来|启动服务|start\s+(?:the\s+)?(?:project|app|server|service)|run\s+(?:the\s+)?(?:project|app|server|service)|serve\s+(?:the\s+)?(?:project|app))/iu;

/** Builds deterministic acceptance predicates for project launch tasks. */
export async function createTaskRequest(workspaceRoot: string, objective: string): Promise<TaskRequest> {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("Task objective cannot be empty.");
  if (!launchIntentPattern.test(trimmed)) return { objective: trimmed, acceptanceCriteria: [] };

  const manifests = await discoverFiles(workspaceRoot, new Set(["pom.xml", "package.json"]), 3, 2_000);
  const criteria: AcceptanceCriterion[] = [];
  const pendingTodo: string[] = [];
  const mavenProjects = manifests.filter((filePath) => path.basename(filePath) === "pom.xml");
  const nodeProjects: NodeProject[] = [];

  for (const manifestPath of manifests) {
    const relative = toRelative(workspaceRoot, manifestPath);
    criteria.push({
      id: criterionId("file", relative),
      kind: "file_exists",
      path: relative,
      description: `Required project file ${relative}`
    });
    if (path.basename(manifestPath) !== "package.json") continue;
    const project = await readNodeProject(manifestPath);
    if (project) nodeProjects.push(project);
  }

  for (const pomPath of mavenProjects) {
    const cwd = toRelative(workspaceRoot, path.dirname(pomPath));
    criteria.push({
      id: criterionId("maven-test", cwd),
      kind: "command_succeeded",
      commandPattern: "(?:^|\\s)(?:\\./mvnw|mvn)(?:\\s+[^;&|]*)?\\s+test(?:\\s|$)",
      cwd,
      description: `Maven tests in ${cwd}`
    });
    criteria.push({
      id: criterionId("backend-process", cwd),
      kind: "managed_process",
      cwd,
      requireHttpReadiness: true,
      description: `Backend service in ${cwd}`
    });
    pendingTodo.push(`Keep the backend in ${cwd} managed and HTTP-ready.`);
  }

  for (const project of nodeProjects) {
    const cwd = toRelative(workspaceRoot, project.directory);
    if (project.scripts.has("build")) {
      criteria.push({
        id: criterionId("node-build", cwd),
        kind: "command_succeeded",
        commandPattern: "(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+build(?:\\s|$)",
        cwd,
        description: `Frontend build in ${cwd}`
      });
    }
    if (project.scripts.has("test") && !isPlaceholderTest(project.scripts.get("test"))) {
      criteria.push({
        id: criterionId("node-test", cwd),
        kind: "command_succeeded",
        commandPattern: "(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+test(?:\\s|$)",
        cwd,
        description: `Frontend tests in ${cwd}`
      });
    }
    if (!project.isFrontend) continue;
    criteria.push({
      id: criterionId("frontend-process", cwd),
      kind: "managed_process",
      cwd,
      requireHttpReadiness: true,
      description: `Frontend service in ${cwd}`
    });
    pendingTodo.push(`Keep the frontend in ${cwd} managed and HTTP-ready.`);
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

  return { objective: trimmed, acceptanceCriteria: deduplicateCriteria(criteria), pendingTodo };
}

interface NodeProject {
  directory: string;
  scripts: Map<string, string>;
  isFrontend: boolean;
}

async function readNodeProject(manifestPath: string): Promise<NodeProject | undefined> {
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
      isFrontend: hasViteConfig
        || "vite" in dependencies
        || "react" in dependencies
        || "vue" in dependencies
        || "@angular/core" in dependencies
        || scripts.has("dev") && /vite|next|nuxt|webpack|react-scripts/iu.test(scripts.get("dev") ?? "")
    };
  } catch {
    return undefined;
  }
}

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
      // Try the next conventional filename.
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

function criterionId(prefix: string, value: string): string {
  const suffix = value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "root";
  return `${prefix}-${suffix}`.slice(0, 128);
}

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
