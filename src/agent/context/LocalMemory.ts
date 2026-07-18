import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { generateText, Output, type LanguageModel, type TelemetryOptions } from "ai";
import { z } from "zod";
import { agentDir } from "../../session/store.js";
import { redactSecrets } from "../../utils/secrets.js";
import type { MemoryEntry, MemoryMatch } from "./types.js";
import type { ModelUsageObserver } from "../../observability/usage.js";

const indexFileName = "MEMORY.md";
const maxTopicChars = 24_000;
const memoryModelTimeoutMs = 30_000;

interface PinnedMemoryDirectory {
  workspaceRoot: string;
  path: string;
  device: number | bigint;
  inode: number | bigint;
}

interface PinnedMemoryFile {
  handle: FileHandle;
  name: string;
  device: number | bigint;
  inode: number | bigint;
}

export interface MemoryWriteResult {
  written: boolean;
  path?: string;
}

/**
 * Durable, auditable project memory. This is intentionally keyword and path based:
 * it never builds a vector index or turns source code into embedding records.
 */
export class LocalMemory {
  constructor(
    private readonly workspaceRoot: string,
    private readonly getModel: () => LanguageModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    private readonly telemetry?: (functionId: string) => TelemetryOptions
  ) {}

  async findRelevant(query: string, paths: string[], limit = 3, signal?: AbortSignal): Promise<MemoryMatch[]> {
    signal?.throwIfAborted();
    const terms = tokenize([query, ...paths].join(" "));
    if (!terms.length) return [];

    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return [];
    const index = await readOptionalMemoryFile(this.workspaceRoot, directory, indexFileName, maxTopicChars, signal);
    const topicFiles = [...new Set([...indexedTopicFiles(index), ...await this.listTopicFiles(directory, signal)])];
    const matches = await Promise.all(topicFiles.map(async (fileName) => {
      signal?.throwIfAborted();
      const filePath = path.join(directory.path, fileName);
      const content = await readOptionalMemoryFile(this.workspaceRoot, directory, fileName, maxTopicChars, signal);
      if (!content) return undefined;
      const score = scoreMemory(fileName, `${indexLineForFile(index, fileName)}\n${content}`, terms);
      if (!score) return undefined;
      return {
        topic: fileName.replace(/\.md$/, ""),
        path: path.relative(directory.workspaceRoot, filePath),
        excerpt: createExcerpt(content, terms),
        score
      };
    }));

    signal?.throwIfAborted();
    return matches
      .filter((match): match is MemoryMatch => Boolean(match))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit);
  }

  async rememberSuccessfulTask(task: string, answer: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const safeTask = redactSecrets(task).trim();
    const safeAnswer = redactSecrets(answer).trim();
    if (safeTask.length + safeAnswer.length < 180) return;

    const proposal = await this.extractProposal(safeTask, safeAnswer, signal);
    signal?.throwIfAborted();
    if (proposal) await this.write(proposal, signal);
  }

  async write(rawEntry: MemoryEntry, signal?: AbortSignal): Promise<MemoryWriteResult> {
    signal?.throwIfAborted();
    const entry = sanitizeMemoryEntry(rawEntry);
    if (!entry.summary || entry.summary.length < 20) return { written: false, path: undefined };

    const directory = await resolveMemoryDirectory(this.workspaceRoot, true);
    signal?.throwIfAborted();
    if (!directory) throw new Error("Failed to create local memory storage.");
    const topicFileName = `${normalizeTopic(entry.topic)}.md`;
    assertMemoryFileName(topicFileName, false);
    const filePath = path.join(directory.path, topicFileName);
    const indexFile = await openPinnedMemoryFile(this.workspaceRoot, directory, indexFileName, true);
    if (!indexFile) throw new Error("Failed to open the local memory index.");
    try {
      const topicFile = await openPinnedMemoryFile(this.workspaceRoot, directory, topicFileName, true);
      if (!topicFile) throw new Error(`Failed to open local memory topic: ${topicFileName}`);
      try {
        const existing = await readPinnedMemoryFile(this.workspaceRoot, directory, topicFile, Number.MAX_SAFE_INTEGER);
        signal?.throwIfAborted();
        if (isDuplicate(existing, entry)) return { written: false, path: path.relative(directory.workspaceRoot, filePath) };

        const index = await readPinnedMemoryFile(this.workspaceRoot, directory, indexFile, maxTopicChars);
        signal?.throwIfAborted();
        const line = `- [${topicFileName}](${topicFileName}) | tags: ${entry.keywords.join(", ") || "general"}`;
        const lines = index
          ? index.split("\n").filter((value) => !value.startsWith(`- [${topicFileName}]`))
          : ["# Biny Project Memory", "", "This index links to short, auditable project notes.", ""];
        lines.push(line);

        await assertPinnedMemoryFile(this.workspaceRoot, directory, topicFile);
        await assertPinnedMemoryFile(this.workspaceRoot, directory, indexFile);
        await topicFile.handle.appendFile(renderEntry(entry), "utf8");
        const nextIndex = `${lines.filter(Boolean).join("\n")}\n`;
        await indexFile.handle.truncate(0);
        await indexFile.handle.write(nextIndex, 0, "utf8");
      } finally {
        await topicFile.handle.close();
      }
    } finally {
      await indexFile.handle.close();
    }
    return { written: true, path: path.relative(directory.workspaceRoot, filePath) };
  }

  async listTopics(): Promise<string[]> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return [];
    return (await this.listTopicFiles(directory)).map((fileName) => fileName.replace(/\.md$/, ""));
  }

  private async extractProposal(task: string, answer: string, signal?: AbortSignal): Promise<MemoryEntry | undefined> {
    const prompt = [
      "Extract one durable, auditable local-project memory from a successful coding task.",
      "Skip transient chatter. Never include credentials, secrets, or full source code.",
      "Return JSON only with topic, title, summary, decisions, paths, keywords.",
      "topic must be one of decisions, debugging, workflows, or project.",
      "Task:",
      task,
      "Result:",
      answer
    ].join("\n\n");

    try {
      const response = await generateText({
        model: this.getModel(),
        allowSystemInMessages: true,
        abortSignal: signal,
        maxRetries: 0,
        timeout: memoryModelTimeoutMs,
        output: Output.object({
          schema: memoryEntrySchema,
          name: "biny-memory-entry",
          description: "A durable local project memory entry."
        }),
        telemetry: this.telemetry?.("biny.memory"),
        messages: [
          { role: "system", content: "You write concise project memory records, not explanations." },
          { role: "user", content: prompt }
        ]
      });
      signal?.throwIfAborted();
      await this.onUsage(await response.usage, "memory");
      signal?.throwIfAborted();
      return parseMemoryEntry(await response.output);
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async listTopicFiles(directory: PinnedMemoryDirectory, signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted();
      await assertPinnedMemoryDirectory(this.workspaceRoot, directory);
      const entries = await fs.readdir(directory.path, { withFileTypes: true });
      signal?.throwIfAborted();
      const files = entries
        .map((entry) => entry.name)
        .filter((fileName) => fileName.endsWith(".md") && fileName !== indexFileName)
        .sort((left, right) => left.localeCompare(right));
      for (const fileName of files) {
        const file = await openPinnedMemoryFile(this.workspaceRoot, directory, fileName, false, signal);
        if (!file) continue;
        await file.handle.close();
      }
      await assertPinnedMemoryDirectory(this.workspaceRoot, directory);
      return files;
    } catch (error) {
      signal?.throwIfAborted();
      if (isNotFound(error)) return [];
      throw error;
    }
  }
}

export function formatMemoryMatches(matches: MemoryMatch[]): string {
  if (!matches.length) return "";
  return matches.map((match) => `- ${match.topic}: ${match.excerpt}`).join("\n");
}

export { redactSecrets };

export function normalizeTopic(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

const memoryEntrySchema = z.object({
  topic: z.enum(["decisions", "debugging", "workflows", "project"]),
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([])
});

function parseMemoryEntry(value: unknown): MemoryEntry | undefined {
  try {
    const parsed = typeof value === "string"
      ? JSON.parse(stripCodeFence(value)) as Record<string, unknown>
      : value as Record<string, unknown>;
    const summary = stringValue(parsed.summary);
    if (!summary) return undefined;
    return {
      topic: normalizeTopic(stringValue(parsed.topic) ?? "project"),
      title: stringValue(parsed.title) ?? "Project note",
      summary,
      decisions: stringArray(parsed.decisions),
      paths: stringArray(parsed.paths),
      keywords: stringArray(parsed.keywords)
    };
  } catch {
    return undefined;
  }
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? redactSecrets(value).trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => redactSecrets(item).trim()).filter(Boolean);
}

function sanitizeMemoryEntry(entry: MemoryEntry): MemoryEntry {
  return {
    topic: normalizeTopic(redactSecrets(entry.topic)),
    title: redactSecrets(entry.title).replace(/\s+/g, " ").trim().slice(0, 120),
    summary: redactSecrets(entry.summary).trim().slice(0, 2_000),
    decisions: entry.decisions.map((value) => redactSecrets(value).trim()).filter(Boolean).slice(0, 8),
    paths: entry.paths.map((value) => redactSecrets(value).trim()).filter(Boolean).slice(0, 16),
    keywords: entry.keywords.map((value) => redactSecrets(value).trim().toLowerCase()).filter(Boolean).slice(0, 12)
  };
}

function renderEntry(entry: MemoryEntry): string {
  return [
    `## ${entry.title || "Project note"}`,
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Summary: ${entry.summary}`,
    ...(entry.decisions.length ? ["- Decisions:", ...entry.decisions.map((decision) => `  - ${decision}`)] : []),
    ...(entry.paths.length ? [`- Paths: ${entry.paths.join(", ")}`] : []),
    ...(entry.keywords.length ? [`- Tags: ${entry.keywords.join(", ")}`] : []),
    "",
    ""
  ].join("\n");
}

function isDuplicate(existing: string, entry: MemoryEntry): boolean {
  const normalizedExisting = normalizeForDedup(existing);
  const title = normalizeForDedup(entry.title);
  const summary = normalizeForDedup(entry.summary);
  return Boolean(title) && Boolean(summary) && normalizedExisting.includes(title) && normalizedExisting.includes(summary);
}

function normalizeForDedup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreMemory(fileName: string, content: string, terms: string[]): number {
  const lowerName = fileName.toLowerCase();
  const lowerContent = content.toLowerCase();
  return terms.reduce((score, term) => {
    let next = score;
    if (lowerName.includes(term)) next += 8;
    if (lowerContent.includes(term)) next += 3;
    return next;
  }, 0);
}

function createExcerpt(content: string, terms: string[]): string {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const matched = lines.find((line) => terms.some((term) => line.toLowerCase().includes(term)));
  return redactSecrets(matched ?? lines.at(-1) ?? "").slice(0, 500);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2))].slice(0, 16);
}

function indexedTopicFiles(index: string | undefined): string[] {
  if (!index) return [];
  return [...index.matchAll(/\]\(([^)]+\.md)\)/g)]
    .map((match) => match[1])
    .filter((fileName): fileName is string => {
      if (!fileName || fileName === indexFileName) return false;
      return path.basename(fileName) === fileName;
    });
}

function indexLineForFile(index: string | undefined, fileName: string): string {
  return index?.split("\n").find((line) => line.includes(`(${fileName})`)) ?? "";
}

async function resolveMemoryDirectory(workspaceRoot: string, create: boolean): Promise<PinnedMemoryDirectory | undefined> {
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const agentPath = path.join(canonicalWorkspace, path.basename(agentDir(workspaceRoot)));
  const agent = await ensureRealDirectory(agentPath, create, ".agent");
  if (!agent) return undefined;
  const canonicalAgent = await fs.realpath(agentPath);
  if (canonicalAgent !== path.join(canonicalWorkspace, ".agent")) {
    throw new Error("Local memory storage .agent resolves outside the canonical workspace.");
  }

  const memoryPath = path.join(agentPath, "memory");
  const memory = await ensureRealDirectory(memoryPath, create, ".agent/memory");
  if (!memory) return undefined;
  const canonicalMemory = await fs.realpath(memoryPath);
  if (canonicalMemory !== path.join(canonicalAgent, "memory")) {
    throw new Error("Local memory storage .agent/memory resolves outside the canonical .agent directory.");
  }
  return { workspaceRoot: canonicalWorkspace, path: canonicalMemory, device: memory.dev, inode: memory.ino };
}

async function ensureRealDirectory(directory: string, create: boolean, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error) || !create) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Local memory storage ${label} must be a real directory, not a symbolic link.`);
  }
  await fs.chmod(directory, 0o700);
  return stat;
}

async function assertPinnedMemoryDirectory(workspaceRoot: string, expected: PinnedMemoryDirectory): Promise<void> {
  const current = await resolveMemoryDirectory(workspaceRoot, false);
  if (!current || current.path !== expected.path || current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("Local memory storage changed during access.");
  }
}

async function openPinnedMemoryFile(
  workspaceRoot: string,
  directory: PinnedMemoryDirectory,
  fileName: string,
  create: boolean,
  signal?: AbortSignal
): Promise<PinnedMemoryFile | undefined> {
  signal?.throwIfAborted();
  assertMemoryFileName(fileName, fileName === indexFileName);
  await assertPinnedMemoryDirectory(workspaceRoot, directory);
  const filePath = path.join(directory.path, fileName);
  await assertSafeExistingMemoryLeaf(filePath, fileName, create);

  let handle: FileHandle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDWR | noFollowFlag() | (create ? constants.O_CREAT : 0),
      0o600
    );
  } catch (error) {
    if (!create && isNotFound(error)) return undefined;
    if (isSymbolicLinkError(error)) throw unsafeMemoryFileError(fileName);
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unsafeMemoryFileError(fileName);
    await assertPinnedMemoryDirectory(workspaceRoot, directory);
    await assertMemoryLeafBinding(directory, fileName, stat.dev, stat.ino);
    if (create) await handle.chmod(0o600);
    signal?.throwIfAborted();
    return { handle, name: fileName, device: stat.dev, inode: stat.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSafeExistingMemoryLeaf(filePath: string, fileName: string, allowMissing: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw unsafeMemoryFileError(fileName);
  } catch (error) {
    if (allowMissing && isNotFound(error)) return;
    throw error;
  }
}

async function assertPinnedMemoryFile(
  workspaceRoot: string,
  directory: PinnedMemoryDirectory,
  file: PinnedMemoryFile
): Promise<void> {
  const stat = await file.handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== file.device || stat.ino !== file.inode) {
    throw unsafeMemoryFileError(file.name);
  }
  await assertPinnedMemoryDirectory(workspaceRoot, directory);
  await assertMemoryLeafBinding(directory, file.name, file.device, file.inode);
}

async function assertMemoryLeafBinding(directory: PinnedMemoryDirectory, fileName: string, device: number | bigint, inode: number | bigint): Promise<void> {
  const filePath = path.join(directory.path, fileName);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.dev !== device || stat.ino !== inode) {
    throw unsafeMemoryFileError(fileName);
  }
  if (await fs.realpath(filePath) !== filePath) throw unsafeMemoryFileError(fileName);
}

async function readOptionalMemoryFile(
  workspaceRoot: string,
  directory: PinnedMemoryDirectory,
  fileName: string,
  maxChars = maxTopicChars,
  signal?: AbortSignal
): Promise<string | undefined> {
  const file = await openPinnedMemoryFile(workspaceRoot, directory, fileName, false, signal);
  if (!file) return undefined;
  try {
    const content = await file.handle.readFile({ encoding: "utf8", signal });
    await assertPinnedMemoryFile(workspaceRoot, directory, file);
    return content.slice(0, maxChars);
  } finally {
    await file.handle.close();
  }
}

async function readPinnedMemoryFile(
  workspaceRoot: string,
  directory: PinnedMemoryDirectory,
  file: PinnedMemoryFile,
  maxChars: number
): Promise<string> {
  await assertPinnedMemoryFile(workspaceRoot, directory, file);
  const content = await file.handle.readFile({ encoding: "utf8" });
  await assertPinnedMemoryFile(workspaceRoot, directory, file);
  return content.slice(0, maxChars);
}

function assertMemoryFileName(fileName: string, allowIndex: boolean): void {
  if (
    !fileName
    || fileName.includes("\0")
    || path.basename(fileName) !== fileName
    || !fileName.endsWith(".md")
    || (!allowIndex && fileName.toLowerCase() === indexFileName.toLowerCase())
  ) {
    throw new Error(`Invalid local memory file name: ${fileName}`);
  }
}

function unsafeMemoryFileError(fileName: string): Error {
  return new Error(`Local memory file must be a single regular file, not a symbolic link or hard link: ${fileName}`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
