/**
 * 在途回合状态模块。
 *
 * session JSONL 记的是已经发生的事实，它能重放出历史，但重放不出"这个回合还没跑完"。
 * 之前一个回合被异常打断（进程退出、断网、Ctrl+C）就整个作废，哪怕前面 20 步的工具调用
 * 都成功了 —— 那些 token 全部白烧。
 *
 * 循环拿回自己手里之后，步与步之间有了落盘的位置。这里存的就是每步结束时的完整 context：
 * 下次启动发现它还在，就能从最后一个完成的步继续，而不是从头再来。
 *
 * 工具步之间保存实际已用步数；blocked 或可恢复的 incomplete 终态用 0 保存，表示只有用户
 * 显式 /continue 后才开启一个新预算窗口。正常 completed、cancelled、failed 或新根回合会清掉。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { agentDir, ensureAgentDirs } from "./store.js";

const turnStateVersion = 1;

export interface InterruptedTurn {
  sessionId: string;
  /** 触发这个回合的用户输入，用于向用户描述要续跑的是什么。 */
  prompt: string;
  /** 最后一个完成的步结束时的完整 context。 */
  messages: ModelMessage[];
  completedSteps: number;
  /** Completion Gate 的结构化事实；旧断点没有该字段时按空事实兼容。 */
  facts?: unknown;
  /** blocked / incomplete 终态的恢复边界；普通工具步断点没有该字段。 */
  terminal?: InterruptedTurnTerminal;
  /** 同一 Turn 续跑前已经发生的终态；新预算窗口不能覆盖原终态。 */
  previousTerminals?: InterruptedTurnTerminal[];
  updatedAt: string;
}

export interface InterruptedTurnTerminal {
  status: "blocked" | "incomplete";
  stopReason: string;
  summary: string;
  blockedReason?: string;
  requiredAction?: string;
}

export class TurnStore {
  constructor(private readonly persistenceRoot: string, private readonly sessionId: string) {}

  async save(
    prompt: string,
    messages: readonly ModelMessage[],
    completedSteps: number,
    facts?: unknown,
    terminal?: InterruptedTurnTerminal,
    previousTerminals?: readonly InterruptedTurnTerminal[]
  ): Promise<void> {
    await ensureAgentDirs(this.persistenceRoot);
    const payload: InterruptedTurn = {
      sessionId: this.sessionId,
      prompt,
      messages: [...messages],
      completedSteps,
      facts,
      terminal,
      previousTerminals: previousTerminals ? [...previousTerminals] : undefined,
      updatedAt: new Date().toISOString()
    };
    const target = this.filePath();
    await fs.writeFile(`${target}.tmp`, `${JSON.stringify({ version: turnStateVersion, turn: payload })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
  }

  async load(): Promise<InterruptedTurn | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      const turn = (parsed as { turn?: unknown }).turn;
      return isInterruptedTurn(turn) ? turn : undefined;
    } catch {
      return undefined;
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath(), { force: true });
  }

  private filePath(): string {
    return path.join(agentDir(this.persistenceRoot), "turns", `${this.sessionId}.json`);
  }
}

function isInterruptedTurn(value: unknown): value is InterruptedTurn {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurn>;
  return typeof candidate.sessionId === "string"
    && typeof candidate.prompt === "string"
    && Array.isArray(candidate.messages)
    && candidate.messages.length > 0
    && Number.isSafeInteger(candidate.completedSteps)
    && (candidate.completedSteps ?? -1) >= 0
    && (candidate.terminal === undefined || isInterruptedTurnTerminal(candidate.terminal))
    && (candidate.previousTerminals === undefined
      || Array.isArray(candidate.previousTerminals)
      && candidate.previousTerminals.every(isInterruptedTurnTerminal))
    && typeof candidate.updatedAt === "string";
}

function isInterruptedTurnTerminal(value: unknown): value is InterruptedTurnTerminal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InterruptedTurnTerminal>;
  return (candidate.status === "blocked" || candidate.status === "incomplete")
    && typeof candidate.stopReason === "string"
    && Boolean(candidate.stopReason)
    && typeof candidate.summary === "string"
    && Boolean(candidate.summary)
    && (candidate.blockedReason === undefined || typeof candidate.blockedReason === "string")
    && (candidate.requiredAction === undefined || typeof candidate.requiredAction === "string");
}
