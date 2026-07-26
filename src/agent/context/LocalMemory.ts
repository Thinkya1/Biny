import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { generateText, Output, type LanguageModel, type TelemetryOptions } from "ai";
import { z } from "zod";
import { agentDir } from "../../session/store.js";
import { redactSecrets } from "../../utils/secrets.js";
import type { MemoryCompactionTopicResult, MemoryEntry, MemoryEntrySummary, MemoryMatch } from "./types.js";
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
    private readonly telemetry?: (functionId: string) => TelemetryOptions,
    private readonly getMaxRetries: () => number = () => 0,
    /** 每回合自动注入上下文的记忆条数上限，来自 context.memory.maxRecalled。 */
    readonly recallLimit: number = 3
  ) {}

  async findRelevant(query: string, paths: string[], limit: number = this.recallLimit, signal?: AbortSignal): Promise<MemoryMatch[]> {
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

  /** 按话题读取完整记忆内容；话题不存在时返回 undefined。 */
  async readTopic(topic: string): Promise<string | undefined> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return undefined;
    const fileName = `${normalizeTopic(topic)}.md`;
    assertMemoryFileName(fileName, false);
    return await readOptionalMemoryFile(this.workspaceRoot, directory, fileName, maxTopicChars);
  }

  /** 读取 MEMORY.md 索引，用于 /memory 列表展示。 */
  async readIndex(): Promise<string | undefined> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return undefined;
    return await readOptionalMemoryFile(this.workspaceRoot, directory, indexFileName, maxTopicChars);
  }

  /** 删除一个话题文件并同步清理索引行；话题不存在时返回 false。 */
  async forgetTopic(topic: string): Promise<boolean> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return false;
    const fileName = `${normalizeTopic(topic)}.md`;
    assertMemoryFileName(fileName, false);
    const filePath = path.join(directory.path, fileName);
    try {
      // 删除前先校验目标仍是常规单链接文件，防止软链/硬链把删除引到存储外。
      await assertSafeExistingMemoryLeaf(filePath, fileName, false);
      await fs.unlink(filePath);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    const indexFile = await openPinnedMemoryFile(this.workspaceRoot, directory, indexFileName, false);
    if (indexFile) {
      try {
        const index = await readPinnedMemoryFile(this.workspaceRoot, directory, indexFile, maxTopicChars);
        const lines = index.split("\n").filter((line) => !line.startsWith(`- [${fileName}]`));
        await indexFile.handle.truncate(0);
        await indexFile.handle.write(`${lines.filter(Boolean).join("\n")}\n`, 0, "utf8");
      } finally {
        await indexFile.handle.close();
      }
    }
    return true;
  }

  /** 列出所有话题中的记忆条目（`##` 小节），按日期倒序，供图形界面逐条展示。 */
  async listEntries(signal?: AbortSignal): Promise<MemoryEntrySummary[]> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return [];
    const entries: MemoryEntrySummary[] = [];
    for (const fileName of await this.listTopicFiles(directory, signal)) {
      const content = await readOptionalMemoryFile(this.workspaceRoot, directory, fileName, maxTopicChars, signal);
      if (!content) continue;
      const topic = fileName.replace(/\.md$/, "");
      parseMemorySections(content).sections.forEach((section, index) => {
        entries.push({ topic, index, title: section.title, date: section.date, summary: section.summary.slice(0, 500) });
      });
    }
    // index 仍指向各自话题文件内的原始小节序号，倒序只影响展示顺序。
    return entries.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));
  }

  /** 删除某话题内的一个小节；删空后连同话题文件与索引行一起清掉。 */
  async deleteEntry(topic: string, index: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const directory = await resolveMemoryDirectory(this.workspaceRoot, false);
    if (!directory) return false;
    const fileName = `${normalizeTopic(topic)}.md`;
    assertMemoryFileName(fileName, false);
    let file: PinnedMemoryFile | undefined;
    try {
      file = await openPinnedMemoryFile(this.workspaceRoot, directory, fileName, false, signal);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (!file) return false;
    let remaining = 0;
    try {
      const content = await readPinnedMemoryFile(this.workspaceRoot, directory, file, Number.MAX_SAFE_INTEGER);
      const { preamble, sections } = parseMemorySections(content);
      if (index < 0 || index >= sections.length) return false;
      const rest = sections.filter((_, sectionIndex) => sectionIndex !== index);
      remaining = rest.length;
      if (remaining) {
        await assertPinnedMemoryFile(this.workspaceRoot, directory, file);
        await file.handle.truncate(0);
        await file.handle.write(renderTopicFile(preamble, rest.map((section) => section.raw)), 0, "utf8");
      }
    } finally {
      await file.handle.close();
    }
    return remaining ? true : await this.forgetTopic(topic);
  }

  /**
   * 记忆整理：逐话题让模型合并重复/相近条目、丢弃无长期价值的内容，再整体重写话题文件。
   * 单个话题失败只标记该话题并保持原文件不动，不影响其余话题。
   */
  async compactTopics(topics?: string[], signal?: AbortSignal): Promise<MemoryCompactionTopicResult[]> {
    signal?.throwIfAborted();
    const targets = topics?.length ? topics.map((topic) => normalizeTopic(topic)) : await this.listTopics();
    const results: MemoryCompactionTopicResult[] = [];
    for (const topic of [...new Set(targets)]) {
      signal?.throwIfAborted();
      results.push(await this.compactTopic(topic, signal));
    }
    return results;
  }

  private async compactTopic(topic: string, signal?: AbortSignal): Promise<MemoryCompactionTopicResult> {
    const content = await this.readTopic(topic);
    if (!content) return { topic, before: 0, after: 0, error: "Topic not found." };
    const before = parseMemorySections(content).sections.length;
    if (before < 2) return { topic, before, after: before };

    let merged: MemoryEntry[];
    try {
      merged = await this.mergeEntriesWithModel(topic, content, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { topic, before, after: before, error: error instanceof Error ? error.message : String(error) };
    }
    signal?.throwIfAborted();
    // 合并结果必须严格更少且非空，否则视为模型输出不可用，保留原文件。
    if (!merged.length || merged.length >= before) {
      return merged.length === before
        ? { topic, before, after: before }
        : { topic, before, after: before, error: "Model returned an unusable merge result." };
    }
    await this.rewriteTopic(topic, merged, signal);
    return { topic, before, after: merged.length };
  }

  /** 用给定条目整体重写话题文件并同步索引行；文件防御逻辑与 write 一致。 */
  private async rewriteTopic(topic: string, entries: MemoryEntry[], signal?: AbortSignal): Promise<void> {
    const directory = await resolveMemoryDirectory(this.workspaceRoot, true);
    if (!directory) throw new Error("Failed to open local memory storage.");
    const topicFileName = `${normalizeTopic(topic)}.md`;
    assertMemoryFileName(topicFileName, false);
    const keywords = [...new Set(entries.flatMap((entry) => entry.keywords))].slice(0, 12);
    const indexFile = await openPinnedMemoryFile(this.workspaceRoot, directory, indexFileName, true, signal);
    if (!indexFile) throw new Error("Failed to open the local memory index.");
    try {
      const topicFile = await openPinnedMemoryFile(this.workspaceRoot, directory, topicFileName, true, signal);
      if (!topicFile) throw new Error(`Failed to open local memory topic: ${topicFileName}`);
      try {
        const index = await readPinnedMemoryFile(this.workspaceRoot, directory, indexFile, maxTopicChars);
        signal?.throwIfAborted();
        const lines = index
          ? index.split("\n").filter((value) => !value.startsWith(`- [${topicFileName}]`))
          : ["# Biny Project Memory", "", "This index links to short, auditable project notes.", ""];
        lines.push(`- [${topicFileName}](${topicFileName}) | tags: ${keywords.join(", ") || "general"}`);

        await assertPinnedMemoryFile(this.workspaceRoot, directory, topicFile);
        await assertPinnedMemoryFile(this.workspaceRoot, directory, indexFile);
        await topicFile.handle.truncate(0);
        await topicFile.handle.write(entries.map((entry) => renderEntry(entry)).join(""), 0, "utf8");
        await indexFile.handle.truncate(0);
        await indexFile.handle.write(`${lines.filter(Boolean).join("\n")}\n`, 0, "utf8");
      } finally {
        await topicFile.handle.close();
      }
    } finally {
      await indexFile.handle.close();
    }
  }

  private async mergeEntriesWithModel(topic: string, content: string, signal?: AbortSignal): Promise<MemoryEntry[]> {
    const prompt = [
      "Consolidate this project memory topic file. Merge duplicate or near-duplicate entries,",
      "combine entries about the same subject, and drop entries with no durable value.",
      "Keep every distinct durable fact; preserve concrete paths, decisions, and keywords.",
      "Never invent new facts and never include credentials or secrets.",
      `Topic: ${topic}`,
      "Current entries (Markdown):",
      content
    ].join("\n\n");
    const response = await generateText({
      model: this.getModel(),
      allowSystemInMessages: true,
      abortSignal: signal,
      maxRetries: this.getMaxRetries(),
      timeout: memoryModelTimeoutMs,
      output: Output.object({
        schema: compactedEntriesSchema,
        name: "biny-memory-compaction",
        description: "Consolidated entries for one local project memory topic."
      }),
      telemetry: this.telemetry?.("biny.memory.compact"),
      messages: [
        { role: "system", content: "You consolidate project memory records without losing durable facts." },
        { role: "user", content: prompt }
      ]
    });
    await this.onUsage(await response.usage, "memory");
    signal?.throwIfAborted();
    const output = await response.output;
    return output.entries
      .map((entry) => sanitizeMemoryEntry({ ...entry, topic }))
      .filter((entry) => entry.summary.length >= 20);
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
        maxRetries: this.getMaxRetries(),
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

const compactedEntriesSchema = z.object({
  entries: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    decisions: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([])
  })).default([])
});

interface ParsedMemorySection {
  title: string;
  date?: string;
  summary: string;
  /** 小节原文（含 `##` 标题行），删除/重写时按整段搬运，避免破坏手工编辑的内容。 */
  raw: string;
}

/** 把话题文件拆成 `##` 小节。文件可能被人手工编辑过，字段缺失时按能取到的内容降级。 */
function parseMemorySections(content: string): { preamble: string; sections: ParsedMemorySection[] } {
  const lines = content.split("\n");
  const sections: ParsedMemorySection[] = [];
  let preambleEnd = lines.length;
  let current: string[] | undefined;
  const flush = (): void => {
    if (!current) return;
    const title = current[0]?.replace(/^##\s*/, "").trim() || "Project note";
    const date = current.find((line) => line.trim().startsWith("- Date:"))?.replace(/^\s*- Date:\s*/, "").trim();
    const summary = current.find((line) => line.trim().startsWith("- Summary:"))?.replace(/^\s*- Summary:\s*/, "").trim()
      ?? current.slice(1).map((line) => line.trim()).find(Boolean)
      ?? "";
    sections.push({ title, date, summary, raw: current.join("\n") });
  };
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      if (!current) preambleEnd = index;
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  });
  flush();
  return { preamble: lines.slice(0, preambleEnd).join("\n"), sections };
}

function renderTopicFile(preamble: string, sectionRaws: string[]): string {
  const head = preamble.trim() ? `${preamble.replace(/\s+$/, "")}\n\n` : "";
  return `${head}${sectionRaws.map((raw) => `${raw.replace(/\s+$/, "")}\n\n`).join("")}`;
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

/**
 * 检索词切分。ASCII 走原有的分隔符切词；CJK 文本没有空格分界，按连续汉字段生成
 * 二元词组（bigram），让中文任务描述也能命中记忆内容的子串匹配。
 */
function tokenize(value: string): string[] {
  const lower = value.toLowerCase();
  const ascii = lower.split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2);
  const cjk: string[] = [];
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) cjk.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) cjk.push(run.slice(index, index + 2));
  }
  return [...new Set([...ascii, ...cjk])].slice(0, 32);
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
