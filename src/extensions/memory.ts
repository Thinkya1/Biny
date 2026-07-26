/**
 * 记忆工具模块。
 *
 * 自动记忆抽取只覆盖「任务成功后」的路径；这两个工具让模型可以主动读写
 * 持久记忆：save_memory 显式沉淀一条可审计的项目记忆，recall_memory 按需
 * 检索超出自动注入条数的记忆内容。存储与防御逻辑全部复用 LocalMemory。
 */
import { z } from "zod";
import type { LocalMemory } from "../agent/context/LocalMemory.js";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";

const saveMemorySchema = z.object({
  topic: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(20).max(2_000),
  decisions: z.array(z.string().trim().min(1)).max(8).default([]),
  paths: z.array(z.string().trim().min(1)).max(16).default([]),
  keywords: z.array(z.string().trim().min(1)).max(12).default([])
});

const recallMemorySchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  topic: z.string().trim().min(1).max(64).optional()
});

export function createMemoryTools(getMemory: () => LocalMemory | undefined): Tool[] {
  return [createSaveMemoryTool(getMemory), createRecallMemoryTool(getMemory)];
}

function createSaveMemoryTool(getMemory: () => LocalMemory | undefined): Tool {
  return {
    name: "save_memory",
    description: "Save one durable, auditable project memory entry (decision, convention, gotcha, workflow) to the local memory store under .agent/memory. Use it when the user asks you to remember something or when you learn a non-obvious project fact worth keeping across sessions. Never store secrets or large source excerpts.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Kebab-case topic file the note belongs to, e.g. decisions, debugging, workflows, project, or a new topic." },
        title: { type: "string", description: "Short title of the memory entry." },
        summary: { type: "string", description: "The durable fact itself, 20-2000 characters, self-contained." },
        decisions: { type: "array", items: { type: "string" }, description: "Optional explicit decisions captured by this entry." },
        paths: { type: "array", items: { type: "string" }, description: "Optional related workspace-relative paths." },
        keywords: { type: "array", items: { type: "string" }, description: "Optional retrieval keywords." }
      },
      required: ["topic", "title", "summary"],
      additionalProperties: false
    },
    schema: saveMemorySchema,
    source: "builtin",
    capability: "memory.write",
    risk: "write",
    resolveExecution(args: unknown) {
      const parsed = saveMemorySchema.safeParse(args);
      if (!parsed.success) {
        const message = `save_memory requires topic, title, and a summary of at least 20 characters.`;
        return { isError: true as const, result: message, errorMessage: message };
      }
      const entry = parsed.data;
      return {
        // 写入涉及话题文件与索引两个文件，保守地与其他写操作串行。
        accesses: ToolAccesses.all(),
        display: { kind: "generic" as const, summary: `Remember: ${entry.title}`, detail: { topic: entry.topic } },
        description: `Save a durable memory entry to .agent/memory/${entry.topic}.md`,
        approvalRule: "save_memory",
        async execute(): Promise<unknown> {
          const memory = getMemory();
          if (!memory) throw new Error("Local memory is disabled (context.memory.enabled = false).");
          const result = await memory.write(entry);
          return result.written
            ? { saved: true, path: result.path }
            : { saved: false, reason: "An equivalent entry already exists or the summary is too short.", path: result.path };
        }
      };
    }
  };
}

function createRecallMemoryTool(getMemory: () => LocalMemory | undefined): Tool {
  return {
    name: "recall_memory",
    description: "Search the durable local project memory store (.agent/memory) for notes relevant to a query, or read one full topic. Use it when past decisions, debugging notes, or workflows may already cover the current task.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or file paths describing what to recall." },
        topic: { type: "string", description: "Optional exact topic name to read in full instead of searching." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: recallMemorySchema,
    source: "builtin",
    capability: "memory.read",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = recallMemorySchema.safeParse(args);
      if (!parsed.success) {
        const message = "recall_memory requires a query.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const { query, topic } = parsed.data;
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic" as const, summary: "Recall project memory", detail: topic ?? query },
        description: topic ? `Read memory topic ${topic}` : `Search project memory for: ${query}`,
        approvalRule: "recall_memory",
        async execute(): Promise<unknown> {
          const memory = getMemory();
          if (!memory) throw new Error("Local memory is disabled (context.memory.enabled = false).");
          if (topic) {
            const content = await memory.readTopic(topic);
            return content !== undefined
              ? { topic, content }
              : { topic, content: undefined, availableTopics: await memory.listTopics() };
          }
          const matches = await memory.findRelevant(query, [], 8);
          return matches.length
            ? { matches }
            : { matches: [], availableTopics: await memory.listTopics() };
        }
      };
    }
  };
}
