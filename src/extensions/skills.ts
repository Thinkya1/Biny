/**
 * 技能扩展模块（渐进式披露）。
 *
 * 会话启动时只扫描技能元数据（frontmatter 的 name/description）拼进 system prompt，
 * 完整指令由 invoke_skill 工具在被调用时按需读取。技能可以放在项目内配置的目录
 * （默认 .biny/skills）或全局 ~/.biny/skills，项目级同名技能覆盖全局。
 */
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";

const maxSkillCount = 32;
const maxSkillMetadataBytes = 8 * 1024;
const maxSkillInstructionBytes = 64 * 1024;
const maxSkillDescriptionChars = 300;

export type SkillScope = "project" | "global";

export interface SkillDefinition {
  name: string;
  description: string;
  /** Display path: project skills are workspace-relative, global skills use "~/". */
  path: string;
  /** Canonical absolute path of the skill markdown file. */
  filePath: string;
  /** Root the file must stay inside when it is re-read at invoke time. */
  rootPath: string;
  scope: SkillScope;
}

export interface SkillBundle {
  skills: SkillDefinition[];
  paths: string[];
  prompt: string;
}

export interface LoadSkillsOptions {
  workspaceRoot: string;
  /** Workspace-relative paths from extensions.skills. */
  projectPaths: string[];
  /** Global skill directory; defaults to ~/.biny/skills. */
  globalRoot?: string;
}

interface SkillFileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface SkillFileCandidate {
  path: string;
  snapshot: SkillFileSnapshot;
}

export async function loadSkills(options: LoadSkillsOptions): Promise<SkillBundle> {
  const canonicalWorkspace = await fs.realpath(path.resolve(options.workspaceRoot));
  const skills: SkillDefinition[] = [];
  const usedNames = new Set<string>();
  const seen = new Set<string>();
  // 逐个配置目录收集并按名字去重：先配置的目录（默认 .biny/skills）同名优先。
  for (const configuredPath of options.projectPaths) {
    if (skills.length >= maxSkillCount) break;
    const absolutePath = await resolveRootedSkillPath(canonicalWorkspace, configuredPath);
    if (!absolutePath) continue;
    const files: SkillFileCandidate[] = [];
    await collectSkillFiles(canonicalWorkspace, absolutePath, files, seen);
    await appendSkillDefinitions(skills, usedNames, canonicalWorkspace, files, "project");
  }

  // 全局技能在项目技能之后加载，同名时项目级优先。
  const globalRoot = options.globalRoot ?? path.join(os.homedir(), ".biny", "skills");
  try {
    const canonicalGlobalRoot = await resolveGlobalSkillRoot(globalRoot);
    if (canonicalGlobalRoot) {
      const globalFiles: SkillFileCandidate[] = [];
      await collectSkillFiles(canonicalGlobalRoot, canonicalGlobalRoot, globalFiles, new Set());
      await appendSkillDefinitions(skills, usedNames, canonicalGlobalRoot, globalFiles, "global");
    }
  } catch {
    // 全局目录里的软链/硬链/权限问题只放弃全局技能：拒绝加载已达到防御目的，
    // 不能让一个共享目录的异常阻止所有工作区启动。项目内路径仍保持硬失败。
  }

  return {
    skills,
    paths: skills.map((skill) => skill.path),
    prompt: buildSkillPrompt(skills)
  };
}

async function appendSkillDefinitions(
  skills: SkillDefinition[],
  usedNames: Set<string>,
  rootPath: string,
  files: SkillFileCandidate[],
  scope: SkillScope
): Promise<void> {
  for (const candidate of files.sort((left, right) => left.path.localeCompare(right.path))) {
    if (skills.length >= maxSkillCount) break;
    const definition = await readSkillMetadata(rootPath, candidate, scope);
    if (!definition || usedNames.has(definition.name)) continue;
    usedNames.add(definition.name);
    skills.push(definition);
  }
}

function buildSkillPrompt(skills: SkillDefinition[]): string {
  if (!skills.length) return "";
  const lines = [
    "Available skills (metadata only; full instructions are not loaded yet):",
    ...skills.map((skill) => `- ${skill.name} (${skill.scope}): ${skill.description}`),
    "Before doing a task that matches a skill, call the invoke_skill tool with that skill name and follow the returned instructions."
  ];
  return lines.join("\n");
}

const invokeSkillArgsSchema = z.object({ skill: z.string().trim().min(1) });

export function createSkillTool(bundle: SkillBundle): Tool {
  return {
    name: "invoke_skill",
    description: "Load the full instructions of an available skill by name. Call this before performing a task that a listed skill covers, then follow the returned instructions.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name exactly as listed in the available skills." }
      },
      required: ["skill"],
      additionalProperties: false
    },
    schema: invokeSkillArgsSchema,
    source: "skill",
    capability: "skills",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = invokeSkillArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { isError: true as const, result: "invoke_skill requires a skill name.", errorMessage: "invoke_skill requires a skill name." };
      }
      const requested = parsed.data.skill;
      const definition = bundle.skills.find((skill) => skill.name === requested)
        ?? bundle.skills.find((skill) => skill.name.toLowerCase() === requested.toLowerCase());
      if (!definition) {
        const known = bundle.skills.map((skill) => skill.name).join(", ") || "none";
        const message = `Unknown skill: ${requested}. Available skills: ${known}.`;
        return { isError: true as const, result: message, errorMessage: message };
      }
      return {
        accesses: ToolAccesses.readFile(definition.filePath),
        display: { kind: "generic" as const, summary: `Skill ${definition.name}`, detail: { path: definition.path } },
        description: `Load skill instructions from ${definition.path}`,
        approvalRule: `invoke_skill:${definition.name}`,
        async execute(): Promise<unknown> {
          const content = await readSkillFileFresh(definition.rootPath, definition.filePath, maxSkillInstructionBytes);
          const { body } = splitFrontmatter(content);
          const files = await listSkillSiblingFiles(definition.filePath);
          const result: Record<string, unknown> = {
            skill: definition.name,
            scope: definition.scope,
            path: definition.path,
            instructions: body.trim() || content.trim(),
            files
          };
          // 全局技能位于工作区外，read_file 够不到附属文件，直接内联小体积文本内容。
          if (definition.scope === "global" && files.length) {
            result.bundledFiles = await readGlobalSiblingFiles(path.dirname(definition.filePath), files);
          }
          return result;
        }
      };
    }
  };
}

async function readSkillMetadata(rootPath: string, candidate: SkillFileCandidate, scope: SkillScope): Promise<SkillDefinition | undefined> {
  let content: string;
  try {
    content = await readBoundedSkillFile(rootPath, candidate, maxSkillMetadataBytes);
  } catch {
    // A missing or unreadable optional skill should not stop the runtime.
    return undefined;
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const fallbackName = deriveSkillName(candidate.path);
  const name = normalizeSkillName(frontmatter.name ?? fallbackName);
  if (!name) return undefined;
  const description = truncateChars(
    (frontmatter.description ?? firstDescriptiveLine(body) ?? "No description provided.").trim(),
    maxSkillDescriptionChars
  );
  const relative = path.relative(rootPath, candidate.path);
  return {
    name,
    description,
    path: scope === "global" ? globalDisplayPath(rootPath, relative) : relative,
    filePath: candidate.path,
    rootPath,
    scope
  };
}

/** 全局技能展示路径：在 home 下时用 "~" 缩写，否则用实际绝对路径。 */
function globalDisplayPath(rootPath: string, relative: string): string {
  const fromHome = path.relative(os.homedir(), rootPath);
  if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return path.join("~", fromHome, relative);
  return path.join(rootPath, relative);
}

/** SKILL.md 用上级目录名作为技能名，普通 .md 用文件名主干。 */
function deriveSkillName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  if (stem.toLowerCase() === "skill") return path.basename(path.dirname(filePath));
  return stem;
}

function normalizeSkillName(value: string): string {
  return value.trim().replace(/\s+/g, "-").slice(0, 64);
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function splitFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).trim() !== "---") return { frontmatter: {}, body: content };
  const closing = content.indexOf("\n---", firstLineEnd);
  if (closing === -1) return { frontmatter: {}, body: content };
  const closingLineEnd = content.indexOf("\n", closing + 1);
  const raw = content.slice(firstLineEnd + 1, closing);
  const lines = raw.split("\n");
  // 只有 fence 之间全部是 "key: value" 形式才当 frontmatter 解析，
  // 避免把以水平分割线开头的正文误判成元数据而丢掉内容。
  if (!lines.every((line) => !line.trim() || /^\s*[A-Za-z0-9_-]+\s*:/.test(line))) {
    return { frontmatter: {}, body: content };
  }
  const body = closingLineEnd === -1 ? "" : content.slice(closingLineEnd + 1);
  const frontmatter: SkillFrontmatter = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key !== "name" && key !== "description") continue;
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (value) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstDescriptiveLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed;
  }
  return undefined;
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

const maxBundledFileBytes = 8 * 1024;
const maxBundledTotalBytes = 24 * 1024;
const bundledTextExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".sh", ".py", ".js", ".ts"]);

/** 内联全局技能的文本附属文件（软链/硬链跳过，单文件与总量都设上限）。 */
async function readGlobalSiblingFiles(directory: string, names: string[]): Promise<Array<{ name: string; content: string }>> {
  const bundled: Array<{ name: string; content: string }> = [];
  let usedBytes = 0;
  for (const name of names) {
    if (usedBytes >= maxBundledTotalBytes) break;
    if (!bundledTextExtensions.has(path.extname(name).toLowerCase())) continue;
    const filePath = path.join(directory, name);
    try {
      const stat = await fs.lstat(filePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) continue;
      const content = await readBoundedSkillFile(
        directory,
        { path: filePath, snapshot: skillSnapshot(stat) },
        Math.min(maxBundledFileBytes, maxBundledTotalBytes - usedBytes)
      );
      usedBytes += Buffer.byteLength(content, "utf8");
      bundled.push({ name, content });
    } catch {
      // 附属文件读取失败不影响技能本体。
    }
  }
  return bundled;
}

async function listSkillSiblingFiles(skillFilePath: string): Promise<string[]> {
  // 目录式技能可以携带模板、脚本等附属文件；这里只列文件名供模型继续用读取工具查看。
  if (path.basename(skillFilePath).toLowerCase() !== "skill.md") return [];
  try {
    const entries = await fs.readdir(path.dirname(skillFilePath), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== "skill.md")
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** invoke 时重新校验并读取，允许文件在会话期间被正常编辑，但保持符号链接/硬链接/越界防御。 */
async function readSkillFileFresh(rootPath: string, filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Skill file cannot be a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Skill path is not a file: ${filePath}`);
  if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${filePath}`);
  if (await escapesRoot(rootPath, filePath)) throw new Error(`Skill file escapes its root: ${filePath}`);
  return await readBoundedSkillFile(rootPath, { path: filePath, snapshot: skillSnapshot(stat) }, maxBytes);
}

async function collectSkillFiles(rootPath: string, target: string, files: SkillFileCandidate[], seen: Set<string>): Promise<void> {
  if (files.length >= maxSkillCount) return;
  let stat;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`Skill paths cannot contain symbolic links: ${target}`);
  if (await escapesRoot(rootPath, target)) throw new Error(`Skill path escapes workspace: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${target}`);
    if (path.extname(target).toLowerCase() === ".md" && !seen.has(target)) {
      seen.add(target);
      files.push({ path: target, snapshot: skillSnapshot(stat) });
    }
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  // 目录式技能只认 SKILL.md，避免把技能附带的文档一起当成独立技能。
  const skillEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
  if (skillEntry) {
    await collectSkillFiles(rootPath, path.join(target, skillEntry.name), files, seen);
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    await collectSkillFiles(rootPath, path.join(target, entry.name), files, seen);
    if (files.length >= maxSkillCount) return;
  }
}

async function resolveRootedSkillPath(rootPath: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(rootPath, configuredPath);
  const relative = path.relative(rootPath, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill path must stay inside workspace: ${configuredPath}`);
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Skill paths cannot be symbolic links: ${configuredPath}`);
    const canonical = await fs.realpath(absolutePath);
    if (path.relative(rootPath, canonical).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(rootPath, canonical))) {
      throw new Error(`Skill path escapes workspace: ${configuredPath}`);
    }
    if (canonical !== absolutePath) throw new Error(`Skill paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 全局技能根目录允许通过符号链接到达（如 macOS 的 /tmp），但内部仍禁止软链。 */
async function resolveGlobalSkillRoot(globalRoot: string): Promise<string | undefined> {
  try {
    const canonical = await fs.realpath(path.resolve(globalRoot));
    const stat = await fs.lstat(canonical);
    return stat.isDirectory() ? canonical : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function readBoundedSkillFile(rootPath: string, candidate: SkillFileCandidate, maxBytes: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate.path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error(`Skill file changed to a symbolic link before it could be read: ${candidate.path}`);
    throw error;
  }

  try {
    const initial = await assertSkillFileBinding(rootPath, candidate, handle);
    const chunks: Buffer[] = [];
    const readLimit = maxBytes + 4;
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    const current = await assertSkillFileBinding(rootPath, candidate, handle);
    if (!sameSkillSnapshot(initial, current)) throw new Error(`Skill file changed while it was being read: ${candidate.path}`);
    return truncateUtf8(Buffer.concat(chunks, bytesRead).toString("utf8"), maxBytes);
  } finally {
    await handle.close();
  }
}

async function assertSkillFileBinding(
  rootPath: string,
  candidate: SkillFileCandidate,
  handle: FileHandle
): Promise<SkillFileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(candidate.path, { bigint: true });
  const canonical = await fs.realpath(candidate.path);
  const relative = path.relative(rootPath, canonical);
  const snapshot = skillSnapshot(descriptorStat);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1n
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1n
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || canonical !== candidate.path
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !sameSkillSnapshot(candidate.snapshot, snapshot)
  ) {
    throw new Error(`Skill file changed after validation: ${candidate.path}`);
  }
  return snapshot;
}

function skillSnapshot(stat: BigIntStats): SkillFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    links: stat.nlink,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs
  };
}

function sameSkillSnapshot(left: SkillFileSnapshot, right: SkillFileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

async function escapesRoot(rootPath: string, target: string): Promise<boolean> {
  const canonical = await fs.realpath(target);
  const relative = path.relative(rootPath, canonical);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
