/**
 * 桌面端 Skill catalog。
 *
 * 这个模块只负责发现和安全读写本机 Skill，不负责把 Skill 注入 Agent prompt。
 * 运行时继续使用 `skills.ts` 的渐进式披露；桌面端和运行时通过同一套目录约定保持一致。
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

const maxMetadataBytes = 512 * 1024;
const maxEditorBytes = 512 * 1024;
const maxSkillCount = 512;
const maxFileCount = 512;

export type SkillCatalogScope = "global" | "project";
export type SkillCatalogEngine = "biny" | "codex" | "claude" | "pi";

export interface SkillCatalogFile {
  path: string;
  name: string;
  kind: "file";
  size: number;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  scope: SkillCatalogScope;
  engine: SkillCatalogEngine;
  linkedEngines: SkillCatalogEngine[];
  absolutePath: string;
  mdPath: string;
  projectRoot?: string;
  files: SkillCatalogFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
}

export interface SkillCatalogSnapshot {
  skills: SkillCatalogEntry[];
  warnings: string[];
}

export interface SkillCatalogFilePreview {
  path: string;
  content?: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

interface SkillRoot {
  scope: SkillCatalogScope;
  engine: SkillCatalogEngine;
  directory: string;
  projectRoot?: string;
}

interface DiscoveredSkill {
  root: SkillRoot;
  absolutePath: string;
  mdPath: string;
  name: string;
  description: string;
  files: SkillCatalogFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
}

interface GroupedSkill {
  winner: DiscoveredSkill;
  engines: Set<SkillCatalogEngine>;
}

export async function scanSkillCatalog(options: { homeDir?: string; projectRoots?: string[] } = {}): Promise<SkillCatalogSnapshot> {
  const homeDir = options.homeDir ?? os.homedir();
  const projectRoots = await canonicalProjectRoots(options.projectRoots ?? []);
  const roots = buildSkillRoots(homeDir, projectRoots);
  const results = await Promise.all(roots.map((root) => scanSkillRoot(root)));
  const discoveredWarnings = [...new Set(results.flatMap((result) => result.warnings))];
  const warnings = discoveredWarnings.length > 24
    ? [...discoveredWarnings.slice(0, 24), `还有 ${String(discoveredWarnings.length - 24)} 条扫描警告未展开。`]
    : discoveredWarnings;
  const grouped = new Map<string, GroupedSkill>();

  for (const result of results) {
    for (const item of result.items) {
      const groupKey = `${item.root.scope}:${item.root.projectRoot ?? ""}:${item.absolutePath}`;
      const current = grouped.get(groupKey);
      if (current) {
        current.engines.add(item.root.engine);
        continue;
      }
      grouped.set(groupKey, { winner: item, engines: new Set([item.root.engine]) });
    }
  }

  const skills = [...grouped.values()]
    .map(({ winner, engines }) => toCatalogEntry(winner, [...engines]))
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === "global" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  if (skills.length > maxSkillCount) {
    skills.length = maxSkillCount;
    warnings.push(`只展示前 ${String(maxSkillCount)} 个 Skill。`);
  }
  return { skills, warnings };
}

export async function readSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string): Promise<SkillCatalogFilePreview> {
  const filePath = await resolveSkillCatalogFile(entry, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.size > maxEditorBytes) throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，暂不支持在桌面端编辑。`);
  const buffer = await fs.readFile(filePath);
  const binary = buffer.includes(0);
  return {
    path: relativePath,
    content: binary ? undefined : buffer.toString("utf8"),
    size: stat.size,
    binary,
    truncated: false
  };
}

export async function writeSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > maxEditorBytes) {
    throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，无法保存。`);
  }
  const filePath = await resolveSkillCatalogFile(entry, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.size > maxEditorBytes) throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，无法保存。`);
  const temporaryPath = `${filePath}.biny-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function resolveSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Skill 文件路径必须是相对路径。");
  const skillRoot = await canonicalDirectory(entry.absolutePath);
  const target = path.resolve(skillRoot, relativePath);
  const relative = path.relative(skillRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill 文件路径越界：${relativePath}`);
  }
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Skill 文件不能是符号链接：${relativePath}`);
  if (!stat.isFile()) throw new Error(`Skill 路径不是文件：${relativePath}`);
  if (stat.nlink !== 1) throw new Error(`Skill 文件不能是硬链接：${relativePath}`);
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(skillRoot, realTarget);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Skill 文件路径解析后越界：${relativePath}`);
  }
  return target;
}

function buildSkillRoots(homeDir: string, projectRoots: string[]): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const add = (scope: SkillCatalogScope, engine: SkillCatalogEngine, directory: string, projectRoot?: string): void => {
    roots.push({ scope, engine, directory, projectRoot });
  };

  add("global", "codex", path.join(homeDir, ".agents", "skills"));
  add("global", "pi", path.join(homeDir, ".agents", "skills"));
  add("global", "codex", path.join(homeDir, ".codex", "skills"));
  add("global", "claude", path.join(homeDir, ".claude", "skills"));
  add("global", "pi", path.join(homeDir, ".pi", "agent", "skills"));
  add("global", "biny", path.join(homeDir, ".biny", "skills"));
  add("global", "codex", "/etc/codex/skills");

  for (const projectRoot of projectRoots) {
    add("project", "codex", path.join(projectRoot, ".agents", "skills"), projectRoot);
    add("project", "pi", path.join(projectRoot, ".agents", "skills"), projectRoot);
    add("project", "codex", path.join(projectRoot, ".codex", "skills"), projectRoot);
    add("project", "claude", path.join(projectRoot, ".claude", "skills"), projectRoot);
    add("project", "pi", path.join(projectRoot, ".pi", "agent", "skills"), projectRoot);
    add("project", "biny", path.join(projectRoot, ".biny", "skills"), projectRoot);
  }
  return roots;
}

async function canonicalProjectRoots(projectRoots: string[]): Promise<string[]> {
  const canonical = await Promise.all(projectRoots.map(async (projectRoot) => {
    try {
      const resolved = await canonicalDirectory(projectRoot);
      return resolved;
    } catch {
      return undefined;
    }
  }));
  return [...new Set(canonical.filter((root): root is string => root !== undefined))];
}

async function scanSkillRoot(root: SkillRoot): Promise<{ items: DiscoveredSkill[]; warnings: string[] }> {
  let entries;
  try {
    entries = await fs.readdir(root.directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { items: [], warnings: [] };
    return { items: [], warnings: [`无法扫描 Skill 目录 ${root.directory}：${errorMessage(error)}`] };
  }

  const items: DiscoveredSkill[] = [];
  const warnings: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (items.length >= maxSkillCount) break;
    if (entry.name.startsWith(".") || entry.name.match(/\.bak\.\d+$/u)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const absolutePath = await canonicalDirectory(path.join(root.directory, entry.name));
      const mdPath = await findSkillMarkdown(absolutePath);
      if (!mdPath) continue;
      items.push(await readDiscoveredSkill(root, absolutePath, mdPath));
    } catch (error) {
      if (isNotFound(error)) continue;
      warnings.push(`跳过 Skill ${path.join(root.directory, entry.name)}：${errorMessage(error)}`);
    }
  }
  return { items, warnings };
}

async function readDiscoveredSkill(root: SkillRoot, absolutePath: string, mdPath: string): Promise<DiscoveredSkill> {
  const raw = await readMetadataFile(mdPath);
  let frontmatter: Record<string, unknown> = {};
  let description = "暂无描述";
  let parseError: string | undefined;
  try {
    const parsed = parseSkillDocument(raw);
    frontmatter = parsed.frontmatter;
    const metadataDescription = frontmatter.description;
    description = typeof metadataDescription === "string" && metadataDescription.trim()
      ? metadataDescription.trim()
      : firstDescriptionLine(parsed.body) ?? description;
  } catch (error) {
    parseError = errorMessage(error);
    description = firstDescriptionLine(raw) ?? description;
  }
  const nameValue = frontmatter.name;
  const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : path.basename(absolutePath);
  return {
    root,
    absolutePath,
    mdPath,
    name,
    description: truncate(description, 500),
    files: await listSkillFiles(absolutePath),
    frontmatter,
    parseError
  };
}

function toCatalogEntry(item: DiscoveredSkill, linkedEngines: SkillCatalogEngine[]): SkillCatalogEntry {
  const identity = `${item.root.scope}:${item.root.projectRoot ?? "global"}:${item.absolutePath}`;
  return {
    id: createHash("sha256").update(identity).digest("hex").slice(0, 32),
    name: item.name,
    description: item.description,
    scope: item.root.scope,
    engine: item.root.engine,
    linkedEngines: linkedEngines.sort(),
    absolutePath: item.absolutePath,
    mdPath: item.mdPath,
    projectRoot: item.root.projectRoot,
    files: item.files,
    frontmatter: item.frontmatter,
    parseError: item.parseError
  };
}

async function findSkillMarkdown(directory: string): Promise<string | undefined> {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(directory, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // 继续尝试大小写变体。
    }
  }
  return undefined;
}

async function listSkillFiles(skillRoot: string): Promise<SkillCatalogFile[]> {
  const files: SkillCatalogFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= maxFileCount) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => {
      const leftPrimary = left.name.toLowerCase() === "skill.md" ? 0 : 1;
      const rightPrimary = right.name.toLowerCase() === "skill.md" ? 0 : 1;
      return leftPrimary - rightPrimary || left.name.localeCompare(right.name);
    })) {
      if (files.length >= maxFileCount || entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.lstat(target);
        files.push({ path: path.relative(skillRoot, target).split(path.sep).join("/"), name: entry.name, kind: "file", size: stat.size });
      } catch {
        // 单个文件消失不影响其他文件展示。
      }
    }
  };
  await visit(skillRoot);
  return files;
}

async function canonicalDirectory(directory: string): Promise<string> {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error(`不是目录：${directory}`);
  return await fs.realpath(directory);
}

async function readMetadataFile(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  if (stat.size > maxMetadataBytes) throw new Error(`SKILL.md 超过 ${String(maxMetadataBytes)} 字节。`);
  return await fs.readFile(filePath, "utf8");
}

function parseSkillDocument(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const opening = /^---[ \t]*\r?\n/u.exec(content);
  if (!opening) return { frontmatter: {}, body: content };
  const closingPattern = /^---[ \t]*\r?$/gmu;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(content);
  if (!closing) throw new Error("SKILL.md frontmatter 缺少结束分隔线。");
  const document = parseDocument(content.slice(opening[0].length, closing.index), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`SKILL.md YAML 无法解析：${document.errors[0]?.message ?? "unknown error"}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL.md frontmatter 必须是 YAML 对象。");
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { frontmatter: value as Record<string, unknown>, body: content.slice(bodyStart) };
}

function firstDescriptionLine(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const value = line.trim();
    if (value && !value.startsWith("#") && value !== "---") return value;
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
