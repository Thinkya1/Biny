import { promises as fs } from "node:fs";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { agentDir } from "../../session/store.js";
import { ensureDir } from "../../utils/fs.js";
import type { MemoryEntry, MemoryMatch } from "./types.js";

const indexFileName = "MEMORY.md";
const maxTopicChars = 24_000;

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
    private readonly getModel: () => LanguageModel
  ) {}

  async findRelevant(query: string, paths: string[], limit = 3): Promise<MemoryMatch[]> {
    const terms = tokenize([query, ...paths].join(" "));
    if (!terms.length) return [];

    const index = await readOptional(path.join(this.memoryDirectory(), indexFileName));
    const topicFiles = [...new Set([...indexedTopicFiles(index), ...await this.listTopicFiles()])];
    const matches = await Promise.all(topicFiles.map(async (fileName) => {
      const filePath = path.join(this.memoryDirectory(), fileName);
      const content = await readOptional(filePath);
      if (!content) return undefined;
      const score = scoreMemory(fileName, `${indexLineForFile(index, fileName)}\n${content}`, terms);
      if (!score) return undefined;
      return {
        topic: fileName.replace(/\.md$/, ""),
        path: path.relative(this.workspaceRoot, filePath),
        excerpt: createExcerpt(content, terms),
        score
      };
    }));

    return matches
      .filter((match): match is MemoryMatch => Boolean(match))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit);
  }

  async rememberSuccessfulTask(task: string, answer: string): Promise<void> {
    const safeTask = redactSecrets(task).trim();
    const safeAnswer = redactSecrets(answer).trim();
    if (safeTask.length + safeAnswer.length < 180) return;

    const proposal = await this.extractProposal(safeTask, safeAnswer);
    if (proposal) await this.write(proposal);
  }

  async write(rawEntry: MemoryEntry): Promise<MemoryWriteResult> {
    const entry = sanitizeMemoryEntry(rawEntry);
    if (!entry.summary || entry.summary.length < 20) return { written: false, path: undefined };

    const directory = this.memoryDirectory();
    await ensureDir(directory);
    const topicFileName = `${normalizeTopic(entry.topic)}.md`;
    const filePath = path.join(directory, topicFileName);
    const existing = await readOptional(filePath, Number.MAX_SAFE_INTEGER) ?? "";
    if (isDuplicate(existing, entry)) return { written: false, path: path.relative(this.workspaceRoot, filePath) };

    await fs.appendFile(filePath, renderEntry(entry), "utf8");
    await this.updateIndex(topicFileName, entry.keywords);
    return { written: true, path: path.relative(this.workspaceRoot, filePath) };
  }

  async listTopics(): Promise<string[]> {
    return (await this.listTopicFiles()).map((fileName) => fileName.replace(/\.md$/, ""));
  }

  private memoryDirectory(): string {
    return path.join(agentDir(this.workspaceRoot), "memory");
  }

  private async extractProposal(task: string, answer: string): Promise<MemoryEntry | undefined> {
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
        maxRetries: 0,
        messages: [
          { role: "system", content: "You write concise project memory records, not explanations." },
          { role: "user", content: prompt }
        ]
      });
      return parseMemoryEntry(response.text);
    } catch {
      return undefined;
    }
  }

  private async listTopicFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.memoryDirectory());
      return files.filter((fileName) => fileName.endsWith(".md") && fileName !== indexFileName).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async updateIndex(topicFileName: string, keywords: string[]): Promise<void> {
    const filePath = path.join(this.memoryDirectory(), indexFileName);
    const existing = await readOptional(filePath);
    const line = `- [${topicFileName}](${topicFileName}) | tags: ${keywords.join(", ") || "general"}`;
    const lines = existing
      ? existing.split("\n").filter((value) => !value.startsWith(`- [${topicFileName}]`))
      : ["# Biny Project Memory", "", "This index links to short, auditable project notes.", ""];
    lines.push(line);
    await fs.writeFile(filePath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
  }
}

export function formatMemoryMatches(matches: MemoryMatch[]): string {
  if (!matches.length) return "";
  return matches.map((match) => `- ${match.topic}: ${match.excerpt}`).join("\n");
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
}

export function normalizeTopic(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function parseMemoryEntry(value: string): MemoryEntry | undefined {
  try {
    const parsed = JSON.parse(stripCodeFence(value)) as Record<string, unknown>;
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

async function readOptional(filePath: string, maxChars = maxTopicChars): Promise<string | undefined> {
  try {
    return (await fs.readFile(filePath, "utf8")).slice(0, maxChars);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
