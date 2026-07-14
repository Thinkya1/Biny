import { generateText, Output, type LanguageModel, type LanguageModelUsage, type ModelMessage, type TelemetryOptions } from "ai";
import { z } from "zod";
import { cloneModelMessages, messageReasoning, messageText, messageToolName } from "../modelMessages.js";
import { formatProjectContext } from "../../project/ProjectContext.js";
import { formatMemoryMatches, LocalMemory, redactSecrets } from "./LocalMemory.js";
import { formatRepoMapCandidates, WorkspaceContext } from "./WorkspaceContext.js";
import type { CompactionResult, CompactionStatus, ContextBudgetStatus, ContextStatus, LoadedInstruction, MemoryMatch, RecentWorkspaceActivity, WorkspaceTurnData } from "./types.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import type { SessionContextState } from "../../session/metadata.js";

const retainedHistoryTokens = 5_000;
const summaryTokens = 2_800;

/**
 * Stateful model context for one agent session. It owns conversation history,
 * compaction and prompt assembly; workspace discovery stays in WorkspaceContext.
 */
export class ContextMemory {
  private readonly history: ModelMessage[] = [];
  private readonly pendingMemoryWrites = new Set<Promise<void>>();
  private summary: string | undefined;
  private compactedMessages = 0;
  private lastCompactedAt: string | undefined;
  private lastBudget: ContextBudgetStatus;
  private memoryTopics: string[] = [];

  constructor(
    private readonly getModel: () => LanguageModel,
    private readonly workspace: WorkspaceContext,
    private readonly localMemory: LocalMemory | undefined,
    private readonly maxTokens: number,
    private readonly instructionMaxBytes: number,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    private readonly telemetry?: (functionId: string) => TelemetryOptions
  ) {
    this.lastBudget = { maxTokens, usedTokens: 0, omitted: [], autoCompacted: false, source: "estimated", measuredAt: undefined };
  }

  async initialize(): Promise<void> {
    await this.workspace.initialize();
  }

  async prepareTurn(input: string, systemPrompt: string): Promise<ModelMessage[]> {
    await this.initialize();
    const compaction = await this.compactIfNeeded();
    const workspace = await this.workspace.prepareTurn(input);
    const memoryMatches = await this.findRelevantMemory(input, [...workspace.explicitPaths, ...workspace.recentActivity.paths]);
    this.memoryTopics = [...new Set(memoryMatches.map((match) => match.topic))];
    const assembly = assembleContext(
      systemPrompt,
      input,
      this.history,
      workspace,
      this.summary,
      memoryMatches,
      this.maxTokens,
      compaction.compacted
    );
    this.lastBudget = assembly.budget;
    return assembly.messages;
  }

  replaceHistory(messages: ModelMessage[]): void {
    this.history.splice(0, this.history.length, ...messages.filter((message) => message.role !== "system"));
  }

  getBudget(): ContextBudgetStatus {
    return cloneBudget(this.lastBudget);
  }

  recordProviderUsage(usage: LanguageModelUsage): void {
    if (usage.inputTokens === undefined) return;
    this.lastBudget = {
      ...this.lastBudget,
      usedTokens: Math.max(0, usage.inputTokens),
      source: "provider",
      measuredAt: new Date().toISOString()
    };
  }

  snapshot(): SessionContextState {
    return {
      summary: this.summary,
      compactedMessages: this.compactedMessages,
      lastCompactedAt: this.lastCompactedAt,
      memoryTopics: [...this.memoryTopics],
      budget: cloneBudget(this.lastBudget)
    };
  }

  persistedState(): SessionContextState | undefined {
    const state = this.snapshot();
    return state.summary !== undefined || state.compactedMessages > 0 ? state : undefined;
  }

  getHistory(): ModelMessage[] {
    return cloneModelMessages(this.history);
  }

  observeToolResult(tool: string, args: unknown, result: unknown): void {
    this.workspace.observeToolResult(tool, args, result);
  }

  async compact(hint?: string): Promise<CompactionResult> {
    await this.initialize();
    if (!this.history.length) return { compacted: false, compactedMessageCount: 0, summary: this.summary };

    let retained = takeRecentMessages(this.history, retainedHistoryTokens);
    let compacted = this.history.slice(0, this.history.length - retained.length);
    if (!compacted.length) {
      compacted = [...this.history];
      retained = [];
    }

    this.summary = mergeSummaries(this.summary, await this.createSummary(compacted, hint));
    this.compactedMessages += compacted.length;
    this.lastCompactedAt = new Date().toISOString();
    this.replaceHistory(retained);
    this.refreshEstimatedBudget();
    return { compacted: true, compactedMessageCount: compacted.length, summary: this.summary };
  }

  restore(messages: ModelMessage[], state?: ContextBudgetStatus | SessionContextState): void {
    this.replaceHistory(messages);
    const contextState = isContextState(state) ? state : undefined;
    const budget: ContextBudgetStatus | undefined = contextState?.budget ?? (isContextState(state) ? undefined : state);
    this.summary = contextState?.summary;
    this.compactedMessages = contextState?.compactedMessages ?? 0;
    this.lastCompactedAt = contextState?.lastCompactedAt;
    this.memoryTopics = [...(contextState?.memoryTopics ?? [])];
    this.lastBudget = budget === undefined ? estimateRestoredBudget(this.history, this.maxTokens) : normalizeRestoredBudget(budget, this.maxTokens);
    this.workspace.restoreFromHistory(messages);
  }

  queueSuccessfulTask(task: string, answer: string): void {
    if (!this.localMemory) return;
    const pending = this.localMemory.rememberSuccessfulTask(task, answer).catch(() => {
      // Persistent memory is best effort and must not turn a successful turn into an error.
    });
    this.pendingMemoryWrites.add(pending);
    void pending.finally(() => this.pendingMemoryWrites.delete(pending));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pendingMemoryWrites]);
  }

  async status(): Promise<ContextStatus> {
    await this.initialize();
    const workspace = this.workspace.status();
    return {
      loadedInstructions: workspace.loadedInstructions,
      instructionBytes: workspace.instructionBytes,
      instructionCapBytes: this.instructionMaxBytes,
      snapshotRefreshedAt: workspace.snapshotRefreshedAt,
      snapshotDirty: workspace.snapshotDirty,
      repoMapRefreshedAt: workspace.repoMapRefreshedAt,
      repoMapDirty: workspace.repoMapDirty,
      repoMapEntries: workspace.repoMapEntries,
      activePaths: workspace.activePaths,
      recentActivity: workspace.recentActivity,
      compaction: this.compactionStatus(),
      budget: cloneBudget(this.lastBudget),
      memoryEnabled: Boolean(this.localMemory),
      memoryTopics: [...this.memoryTopics]
    };
  }

  async describe(): Promise<string> {
    const status = await this.status();
    return [
      "Context",
      "",
      `Budget: ${String(status.budget.usedTokens)}/${String(status.budget.maxTokens)} ${status.budget.source === "provider" ? "provider tokens" : "estimated tokens"}`,
      `Auto compacted this turn: ${status.budget.autoCompacted ? "yes" : "no"}`,
      `Snapshot: ${status.snapshotRefreshedAt ?? "not loaded"}${status.snapshotDirty ? " (dirty)" : ""}`,
      `RepoMap: ${String(status.repoMapEntries)} entries, ${status.repoMapRefreshedAt ?? "not loaded"}${status.repoMapDirty ? " (dirty)" : ""}`,
      `Instructions: ${status.loadedInstructions.length ? status.loadedInstructions.join(", ") : "(none)"}`,
      `Instruction bytes: ${String(status.instructionBytes)}/${String(status.instructionCapBytes)}`,
      `Active paths: ${status.activePaths.length ? status.activePaths.join(", ") : "(none)"}`,
      `Compaction: ${status.compaction.summaryPresent ? `summary active; ${String(status.compaction.compactedMessages)} messages compacted` : "not active"}`,
      `Memory: ${status.memoryEnabled ? (status.memoryTopics.length ? status.memoryTopics.join(", ") : "enabled, no matching topic") : "disabled"}`,
      ...(status.budget.omitted.length ? [`Omitted this turn: ${status.budget.omitted.join(", ")}`] : [])
    ].join("\n");
  }

  formatCompaction(result: CompactionResult): string {
    if (!result.compacted) return "Conversation is already within the compaction threshold.";
    return `Compacted ${String(result.compactedMessageCount)} messages. The next turn will use the handoff summary and recent history.`;
  }

  private async compactIfNeeded(): Promise<CompactionResult> {
    if (estimateMessageTokens(this.history) <= Math.floor(this.maxTokens * 0.45)) {
      return { compacted: false, compactedMessageCount: 0, summary: this.summary };
    }
    return await this.compact();
  }

  private async createSummary(messages: ModelMessage[], hint?: string): Promise<string> {
    const transcript = messages.map((message) => {
      const label = message.role === "tool" ? `tool ${messageToolName(message)}` : message.role;
      return `${label}: ${truncateTextToTokens(messageText(message), 700)}`;
    }).join("\n\n");
    const prompt = [
      "Summarize this coding-agent conversation for future model context.",
      "Keep only grounded facts. Use exactly these headings: Goal, Decisions, Files, Command Results, Verification, TODO.",
      "Do not include secrets, credentials, or raw large file contents.",
      hint ? `Focus hint: ${hint}` : "",
      "Conversation:",
      transcript
    ].filter(Boolean).join("\n\n");

    try {
      const result = await generateText({
        model: this.getModel(),
        allowSystemInMessages: true,
        maxRetries: 0,
        output: Output.object({
          schema: summarySchema,
          name: "coding-session-summary",
          description: "A compact factual handoff summary for a local assistant session."
        }),
        telemetry: this.telemetry?.("biny.compaction"),
        messages: [
          { role: "system", content: "You create compact, factual coding-session handoff notes." },
          { role: "user", content: prompt }
        ]
      });
      await this.onUsage(await result.usage, "compaction");
      const summary = formatStructuredSummary(await result.output);
      if (summary) return truncateTextToTokens(redactSecrets(summary), summaryTokens);
    } catch {
      // A compaction failure must not block the active coding task.
    }
    return deterministicSummary(messages);
  }

  private async findRelevantMemory(input: string, paths: string[]): Promise<MemoryMatch[]> {
    if (!this.localMemory) return [];
    try {
      return await this.localMemory.findRelevant(input, paths);
    } catch {
      return [];
    }
  }

  private compactionStatus(): CompactionStatus {
    return {
      summaryPresent: Boolean(this.summary),
      compactedMessages: this.compactedMessages,
      lastCompactedAt: this.lastCompactedAt
    };
  }

  private refreshEstimatedBudget(): void {
    const summaryTokens = this.summary ? estimateTokens(this.summary) + 4 : 0;
    const usedTokens = estimateMessageTokens(this.history) + summaryTokens;
    this.lastBudget = {
      ...this.lastBudget,
      usedTokens,
      source: "estimated",
      measuredAt: undefined
    };
  }
}

const summarySchema = z.object({
  goal: z.string().default(""),
  decisions: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  commandResults: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  todo: z.array(z.string()).default([])
});

type StructuredSummary = z.infer<typeof summarySchema>;

function formatStructuredSummary(summary: StructuredSummary): string {
  return [
    "Goal",
    `- ${summary.goal || "(not recorded)"}`,
    "",
    "Decisions",
    ...formatSummaryItems(summary.decisions),
    "",
    "Files",
    ...formatSummaryItems(summary.files),
    "",
    "Command Results",
    ...formatSummaryItems(summary.commandResults),
    "",
    "Verification",
    ...formatSummaryItems(summary.verification),
    "",
    "TODO",
    ...formatSummaryItems(summary.todo)
  ].join("\n");
}

function formatSummaryItems(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- (none recorded)"];
}

function isContextState(value: ContextBudgetStatus | SessionContextState | undefined): value is SessionContextState {
  return value !== undefined && "budget" in value;
}

function cloneBudget(budget: ContextBudgetStatus): ContextBudgetStatus {
  return { ...budget, omitted: [...budget.omitted] };
}

function normalizeRestoredBudget(budget: ContextBudgetStatus, maxTokens: number): ContextBudgetStatus {
  const source = budget.source ?? "estimated";
  return {
    ...budget,
    maxTokens,
    usedTokens: source === "provider" ? Math.max(0, budget.usedTokens) : Math.min(maxTokens, Math.max(0, budget.usedTokens)),
    omitted: [...budget.omitted],
    source,
    measuredAt: budget.measuredAt
  };
}

function estimateRestoredBudget(history: ModelMessage[], maxTokens: number): ContextBudgetStatus {
  const estimatedTokens = estimateMessageTokens(history);
  return {
    maxTokens,
    usedTokens: Math.min(maxTokens, estimatedTokens),
    omitted: estimatedTokens > maxTokens ? ["older conversation messages"] : [],
    autoCompacted: false,
    source: "estimated",
    measuredAt: undefined
  };
}

interface ContextAssembly {
  messages: ModelMessage[];
  budget: ContextBudgetStatus;
}

function assembleContext(
  systemPrompt: string,
  input: string,
  history: ModelMessage[],
  workspace: WorkspaceTurnData,
  summary: string | undefined,
  memoryMatches: MemoryMatch[],
  maxTokens: number,
  autoCompacted: boolean
): ContextAssembly {
  const omitted: string[] = [];
  const task = input.trim() || "(empty task)";
  const taskBudget = Math.max(1, Math.min(estimateTokens(task), Math.floor(maxTokens * 0.35)));
  const taskContent = truncateTextToTokens(task, taskBudget);
  let remaining = Math.max(0, maxTokens - estimateTokens(taskContent) - 4);
  const systemMessages: ModelMessage[] = [];
  const addSystem = (id: string, content: string, required: boolean): void => {
    if (!content) return;
    const available = Math.max(0, remaining - 4);
    if (!available) {
      omitted.push(id);
      return;
    }
    const fullCost = estimateTokens(content) + 4;
    if (!required && fullCost > remaining) {
      omitted.push(id);
      return;
    }
    const selected = required ? truncateTextToTokens(content, available) : content;
    if (selected !== content) omitted.push(`${id} (trimmed)`);
    systemMessages.push({ role: "system", content: selected });
    remaining -= estimateTokens(selected) + 4;
  };

  addSystem("system rules", systemPrompt, true);
  addSystem("project instructions", formatInstructions(workspace.instructions), true);
  addSystem("project snapshot", `Project snapshot:\n${truncateTextToTokens(formatProjectContext(workspace.snapshot.context), 3_500)}`, false);
  addSystem("explicit paths", formatExplicitPaths(workspace.explicitPaths), false);
  addSystem("recent workspace activity", formatRecentActivity(workspace.recentActivity), false);
  addSystem("conversation summary", summary ? `Conversation handoff summary:\n${summary}` : "", false);
  addSystem("stable memory", formatMemoryMatches(memoryMatches), false);

  const selectedHistory = selectHistory(history, remaining);
  remaining -= estimateMessageTokens(selectedHistory);
  if (selectedHistory.length < history.filter((message) => message.role !== "system").length) omitted.push("older conversation messages");

  addSystem("RepoMap candidates", `RepoMap candidates:\n${formatRepoMapCandidates(workspace.repoMapCandidates)}`, false);
  const messages = [...systemMessages, ...selectedHistory, { role: "user" as const, content: taskContent }];
  return {
    messages,
    budget: { maxTokens, usedTokens: estimateMessageTokens(messages), omitted, autoCompacted, source: "estimated", measuredAt: undefined }
  };
}

function formatInstructions(instructions: LoadedInstruction[]): string {
  return instructions.map((instruction) => `Instructions from ${instruction.path}:\n${instruction.content}`).join("\n\n");
}

function formatExplicitPaths(paths: string[]): string {
  return paths.length ? `Explicit paths mentioned by the task:\n${paths.map((filePath) => `- ${filePath}`).join("\n")}` : "";
}

function formatRecentActivity(activity: RecentWorkspaceActivity): string {
  if (!activity.paths.length && !activity.summaries.length) return "";
  return [
    "Recent workspace activity:",
    ...(activity.paths.length ? [`Files: ${activity.paths.join(", ")}`] : []),
    ...activity.summaries.map((summary) => `- ${summary}`)
  ].join("\n");
}

function selectHistory(history: ModelMessage[], maxTokens: number): ModelMessage[] {
  const candidates = history.filter((message) => message.role !== "system");
  if (!maxTokens || !candidates.length) return [];
  return takeRecentMessages(candidates, maxTokens);
}

function deterministicSummary(messages: ModelMessage[]): string {
  const userMessages = messages.filter((message) => message.role === "user").map(messageText);
  const assistantMessages = messages.filter((message) => message.role === "assistant").map(messageText);
  const toolMessages = messages.filter((message) => message.role === "tool").map((message) => `${messageToolName(message)}: ${messageText(message)}`);
  const paths = [...new Set(messages.flatMap((message) => messageText(message).match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|html)/g) ?? []))].slice(0, 12);
  return truncateTextToTokens(redactSecrets([
    "Goal",
    `- ${userMessages.at(-1) ?? "(not recorded)"}`,
    "",
    "Decisions",
    `- ${assistantMessages.at(-1) ?? "(not recorded)"}`,
    "",
    "Files",
    ...(paths.length ? paths.map((filePath) => `- ${filePath}`) : ["- (none recorded)"]),
    "",
    "Command Results",
    `- ${toolMessages.at(-1) ?? "(none recorded)"}`,
    "",
    "Verification",
    "- Review the recorded tool results before relying on this summary.",
    "",
    "TODO",
    "- Continue from the latest user request."
  ].join("\n")), summaryTokens);
}

function mergeSummaries(previous: string | undefined, next: string): string {
  return truncateTextToTokens(previous ? `Earlier summary:\n${previous}\n\nLatest compacted work:\n${next}` : next, summaryTokens);
}

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + messageTokenCost(message), 0);
}

export function truncateTextToTokens(value: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(value) <= maxTokens) return value;
  const suffix = "\n[truncated]";
  const suffixTokens = estimateTokens(suffix);
  if (maxTokens <= suffixTokens) return suffix.slice(0, Math.max(1, maxTokens));
  const target = maxTokens - suffixTokens;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(value.slice(0, middle)) <= target) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function takeRecentMessages(messages: ModelMessage[], maxTokens: number): ModelMessage[] {
  const turns = groupConversationTurns(messages);
  const selected: ModelMessage[][] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const cost = estimateMessageTokens(turn);
    if (used + cost > maxTokens) break;
    selected.unshift(turn);
    used += cost;
  }
  return selected.flat();
}

function groupConversationTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)?.push(message);
  }
  return turns;
}

function messageTokenCost(message: ModelMessage): number {
  return estimateTokens(messageText(message)) + estimateTokens(messageReasoning(message)) + 4;
}
