/**
 * /memory 命令模块。
 *
 * CLI 与 TUI 共用这一份实现：list/show/add/forget/search/compact 都直接落在
 * LocalMemory 的安全存储上，命令层只做参数解析与文本格式化。
 */
import type { LocalMemory } from "./LocalMemory.js";

export const memoryCommandUsage = "Usage: /memory [list] | show <topic> | add <topic> <note> | forget <topic> | search <query> | compact [topic]";

export async function runMemoryCommand(memory: LocalMemory | undefined, args: string[]): Promise<string> {
  if (!memory) return "Local memory is disabled (context.memory.enabled = false in agent.config.json).";
  const action = args[0]?.toLowerCase() ?? "list";

  if (action === "list" || !action) {
    const topics = await memory.listTopics();
    if (!topics.length) return "Local memory is empty. The agent records durable notes automatically, or use /memory add <topic> <note>.";
    const index = await memory.readIndex();
    return [
      `Memory topics (${String(topics.length)}):`,
      ...topics.map((topic) => `  ${topic}`),
      ...(index ? ["", index.trim()] : []),
      "",
      memoryCommandUsage
    ].join("\n");
  }

  if (action === "show") {
    const topic = args[1]?.trim();
    if (!topic) return "Usage: /memory show <topic>";
    const content = await memory.readTopic(topic);
    return content?.trim() ?? `No memory topic named ${topic}. Use /memory list to see available topics.`;
  }

  if (action === "add") {
    const topic = args[1]?.trim();
    const note = args.slice(2).join(" ").trim();
    if (!topic || !note) return "Usage: /memory add <topic> <note>";
    const result = await memory.write({
      topic,
      title: noteTitle(note),
      summary: note,
      decisions: [],
      paths: [],
      keywords: []
    });
    if (!result.written) {
      return result.path
        ? `Skipped: an equivalent note already exists in ${result.path}.`
        : "Skipped: the note is too short to be a durable memory (at least 20 characters).";
    }
    return `Saved memory note to ${result.path ?? topic}.`;
  }

  if (action === "forget") {
    const topic = args[1]?.trim();
    if (!topic) return "Usage: /memory forget <topic>";
    const removed = await memory.forgetTopic(topic);
    return removed ? `Forgot memory topic ${topic}.` : `No memory topic named ${topic}.`;
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) return "Usage: /memory search <query>";
    const matches = await memory.findRelevant(query, [], 8);
    if (!matches.length) return `No memory matches for: ${query}`;
    return [
      `Memory matches for "${query}":`,
      ...matches.map((match) => `  [${match.topic}] (score ${String(match.score)}) ${match.excerpt}`)
    ].join("\n");
  }

  if (action === "compact") {
    const topic = args[1]?.trim();
    const results = await memory.compactTopics(topic ? [topic] : undefined);
    if (!results.length) return "Local memory is empty; nothing to compact.";
    return [
      "Memory compaction:",
      ...results.map((result) => result.error
        ? `  ${result.topic}: failed (${result.error})`
        : result.after < result.before
          ? `  ${result.topic}: ${String(result.before)} -> ${String(result.after)} entries`
          : `  ${result.topic}: ${String(result.before)} entries, nothing to merge`)
    ].join("\n");
  }

  return memoryCommandUsage;
}

function noteTitle(note: string): string {
  const firstLine = note.split("\n", 1)[0] ?? note;
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 59)}…`;
}
