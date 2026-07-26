/**
 * 回合间的计划清单。
 *
 * 长任务里模型会漂：做到第 12 步时，第 3 步说好要回头改的东西已经不在上下文里了。历史
 * 压缩会让这种遗忘更早发生 —— 被摘要掉的正是那些"待会儿要做"的细节。
 *
 * 这份清单是模型自己维护的锚：每回合注入 system prompt，所以它永远看得见；落盘到
 * `.agent/todos`，所以恢复会话后还在。它和 `TaskRunCoordinator` 的 `pendingTodo` 不是一
 * 回事 —— 那个是任务级的验收遗留项，由 harness 写；这个是模型在一次会话里自己的工作记忆。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureAgentDirs } from "./store.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const maxTodoItems = 50;
export const maxTodoContentLength = 500;

export class TodoStore {
  private items: TodoItem[] = [];
  private loaded = false;

  constructor(private readonly workspaceRoot: string, private readonly sessionId: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.items = normalizeItems(parsed);
    } catch {
      // 没有清单、清单损坏或读不出来，都从空清单开始 —— 它是工作记忆，不是事实来源。
      this.items = [];
    }
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /**
   * 整份替换而不是增量改。模型每次给出完整清单，就不会出现"改第 3 条"却数错序号的
   * 情况，也省掉一套 id 分配和对账逻辑。
   */
  async replace(items: readonly TodoItem[]): Promise<TodoItem[]> {
    if (items.length > maxTodoItems) {
      throw new RangeError(`A plan may hold at most ${String(maxTodoItems)} items; received ${String(items.length)}.`);
    }
    const inProgress = items.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) {
      throw new RangeError("At most one plan item may be in_progress at a time; finish or re-queue the others.");
    }
    for (const item of items) {
      if (!item.content.trim()) throw new RangeError("Plan items must have non-empty content.");
      if (item.content.length > maxTodoContentLength) {
        throw new RangeError(`Plan item content must be at most ${String(maxTodoContentLength)} characters.`);
      }
    }
    this.items = items.map((item) => ({ content: item.content.trim(), status: item.status }));
    await this.persist();
    return this.list();
  }

  /** 注入 system prompt 的段落；清单为空时不占位。 */
  promptSection(): string | undefined {
    if (!this.items.length) return undefined;
    const lines = this.items.map((item, index) => `${String(index + 1)}. [${statusMark(item.status)}] ${item.content}`);
    return [
      "## Current plan",
      "",
      "You maintain this list with `update_todos`. Keep it current: mark an item in_progress when you start it and completed when it is actually done, and add items you discover along the way. Never report work as finished while items remain pending.",
      "",
      ...lines
    ].join("\n");
  }

  private filePath(): string {
    return path.join(path.resolve(this.workspaceRoot), ".agent", "todos", `${this.sessionId}.json`);
  }

  private async persist(): Promise<void> {
    await ensureAgentDirs(this.workspaceRoot);
    const target = this.filePath();
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, items: this.items })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  }
}

function statusMark(status: TodoStatus): string {
  if (status === "completed") return "x";
  return status === "in_progress" ? ">" : " ";
}

function normalizeItems(value: unknown): TodoItem[] {
  if (typeof value !== "object" || value === null) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as { content?: unknown; status?: unknown };
    if (typeof candidate.content !== "string" || !candidate.content.trim()) return [];
    const status: unknown = candidate.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    const item: TodoItem = { content: candidate.content.slice(0, maxTodoContentLength), status };
    return [item];
  }).slice(0, maxTodoItems);
}
