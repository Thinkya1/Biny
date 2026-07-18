import { randomUUID } from "node:crypto";
import type { AgentRunMode, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { AgentPermissionResult, AgentSessionEvent } from "../agent/types.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { ExtensionSection } from "../extensions/report.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionSummary } from "../session/events.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
import type {
  ActiveRunSnapshot,
  AgentHostEvent,
  AgentPermissionEventRequest,
  InteractiveRuntimeSnapshot,
  PendingPermissionSnapshot
} from "./agentEvents.js";

export interface SubmittedAgentRun {
  runId: string;
  messageId: string;
  queued: boolean;
  completion: Promise<void>;
}

interface QueuedAgentRun extends ActiveRunSnapshot {
  resolve(): void;
}

interface PendingPermission extends PendingPermissionSnapshot {
  resolve(result: AgentPermissionResult): void;
}

interface ActiveTool {
  tool: string;
  args: unknown;
  display?: ToolInputDisplay;
  startedAtMs: number;
}

/**
 * UI-independent interactive host for AgentSession. It owns run queuing,
 * permission waits and AbortController state while AgentSession continues to
 * own model context, tools and JSONL persistence.
 */
export class InteractiveAgentRuntime {
  private readonly events = new AgentEventBus<AgentHostEvent>();
  private readonly queue: QueuedAgentRun[] = [];
  private readonly tools = new Map<string, ActiveTool>();
  private readonly permissionRequestIds = new Map<string, string>();
  private activeRun: ActiveRunSnapshot | undefined;
  private pendingPermission: PendingPermission | undefined;
  private abortController: AbortController | undefined;
  private drainPromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly commandRuntime: CommandRuntime) {}

  getInfo(): AgentSessionInfo {
    return this.commandRuntime.agent.getInfo();
  }

  getPermissionMode(): PermissionMode {
    return this.commandRuntime.agent.getPermissionMode();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.commandRuntime.agent.setPermissionMode(mode);
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    return await this.commandRuntime.agent.runPermissionCommand(args);
  }

  listModels(): ModelChoice[] {
    return this.commandRuntime.agent.listModels();
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    if (this.activeRun || this.queue.length) throw new Error("Cannot switch models while a turn is running.");
    return await this.commandRuntime.agent.switchModel(alias, thinking);
  }

  async refreshModelFromDisk(): Promise<ModelRuntimeInfo> {
    if (this.activeRun || this.queue.length) throw new Error("Cannot refresh the model while a turn is running.");
    return await this.commandRuntime.agent.refreshModelFromDisk();
  }

  submitPrompt(input: string, mode: AgentRunMode = "chat"): SubmittedAgentRun {
    if (this.closed) throw new Error("Agent runtime is closed.");
    const sessionId = this.getInfo().sessionId;
    const runId = randomUUID();
    const messageId = randomUUID();
    const queued = this.activeRun !== undefined || this.queue.length > 0;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const run: QueuedAgentRun = {
      sessionId,
      runId,
      messageId,
      input,
      mode,
      status: "queued",
      startedAt: new Date().toISOString(),
      resolve: resolveCompletion
    };
    this.queue.push(run);
    this.events.emit({
      ...this.eventBase(run),
      type: "message.user",
      messageId,
      content: input
    });
    this.drainPromise ??= this.drainQueue();
    return { runId, messageId, queued, completion };
  }

  cancelCurrentRun(): void {
    const active = this.activeRun;
    if (active && this.abortController) {
      this.abortController.abort();
      this.pendingPermission?.resolve({ approved: false, scope: "once", message: "Current turn interrupted." });
      this.pendingPermission = undefined;
    }
    while (this.queue.length) {
      const queued = this.queue.shift();
      if (!queued) continue;
      this.events.emit({
        ...this.eventBase(queued),
        type: "run.aborted",
        durationMs: 0,
        reason: "Cancelled before execution."
      });
      queued.resolve();
    }
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingPermission;
    if (!pending || pending.requestId !== requestId) throw new Error("Permission request is no longer pending.");
    pending.resolve(result);
    this.pendingPermission = undefined;
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    if (this.activeRun || this.queue.length) throw new Error("Cannot resume another session while a turn is running.");
    return await this.commandRuntime.agent.resume(session);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.commandRuntime.agent.listSessions();
  }

  extensionReport(section?: ExtensionSection): string {
    return this.commandRuntime.extensionReport(section);
  }

  async runSubagentTask(task: string): Promise<string> {
    if (this.activeRun || this.queue.length) throw new Error("Cannot run a subagent while a turn is running.");
    return await this.commandRuntime.runSubagentTask(task);
  }

  async contextReport(): Promise<string> {
    return await this.commandRuntime.agent.contextReport();
  }

  usageReport(): string {
    return this.commandRuntime.agent.usageReport();
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.commandRuntime.agent.contextStatus();
  }

  async compactConversation(hint?: string): Promise<string> {
    if (this.activeRun || this.queue.length) throw new Error("Cannot compact while a turn is running.");
    const info = this.getInfo();
    const runId = randomUUID();
    const run = this.standaloneRun(info.sessionId, runId, hint ?? "Compact conversation");
    this.events.emit({ ...this.eventBase(run), type: "compact.started", hint });
    const summary = await this.commandRuntime.agent.compactConversation(hint);
    const context = await this.commandRuntime.agent.contextStatus();
    this.events.emit({ ...this.eventBase(run), type: "compact.completed", summary, context });
    return summary;
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    return {
      info: this.getInfo(),
      permissionMode: this.getPermissionMode(),
      activeRun: this.activeRun ? { ...this.activeRun } : undefined,
      pendingPermission: this.pendingPermission ? {
        sessionId: this.pendingPermission.sessionId,
        runId: this.pendingPermission.runId,
        requestId: this.pendingPermission.requestId,
        toolCallId: this.pendingPermission.toolCallId,
        request: { ...this.pendingPermission.request }
      } : undefined,
      queuedRuns: this.queue.map(({ runId, messageId, input, mode }) => ({ runId, messageId, input, mode }))
    };
  }

  subscribe(listener: (event: AgentHostEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelCurrentRun();
    await this.drainPromise;
    await this.commandRuntime.close();
  }

  private async drainQueue(): Promise<void> {
    try {
      while (this.queue.length && !this.closed) {
        const run = this.queue.shift();
        if (!run) continue;
        await this.executeRun(run);
        run.resolve();
      }
    } finally {
      this.drainPromise = undefined;
    }
  }

  private async executeRun(run: QueuedAgentRun): Promise<void> {
    const agent = this.commandRuntime.agent;
    const startedAtMs = Date.now();
    const info = agent.getInfo();
    run.sessionId = info.sessionId;
    run.status = "thinking";
    run.startedAt = new Date(startedAtMs).toISOString();
    this.activeRun = run;
    this.abortController = new AbortController();
    this.tools.clear();
    this.permissionRequestIds.clear();
    this.events.emit({
      ...this.eventBase(run),
      type: "run.started",
      messageId: run.messageId,
      input: run.input,
      mode: run.mode,
      model: {
        alias: info.modelAlias,
        provider: info.provider,
        label: info.modelLabel,
        reasoning: info.reasoningLabel
      },
      skills: info.skills ?? []
    });

    let failure: string | undefined;
    let assistantContent = "";
    let usage: SessionUsage | undefined;
    let reasoningActive = false;
    try {
      for await (const event of agent.runSdk(run.input, {
        abortSignal: this.abortController.signal,
        confirmPermission: async (request) => await this.waitForPermission(run, request),
        mode: run.mode
      })) {
        const mapped = this.handleAgentEvent(run, event, reasoningActive);
        reasoningActive = mapped.reasoningActive;
        assistantContent = mapped.assistantContent ?? assistantContent;
        failure = mapped.failure ?? failure;
        usage = mapped.usage ?? usage;
      }

      if (reasoningActive) {
        this.events.emit({
          ...this.eventBase(run),
          type: "reasoning.completed",
          messageId: run.messageId,
          status: "分析完成"
        });
      }
      const context = await agent.contextStatus();
      this.events.emit({ ...this.eventBase(run), type: "context.updated", context });
      const durationMs = Date.now() - startedAtMs;
      if (this.abortController.signal.aborted) {
        run.status = "aborted";
        this.events.emit({ ...this.eventBase(run), type: "run.aborted", durationMs, reason: "Current turn interrupted." });
      } else if (failure) {
        run.status = "failed";
        this.events.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: failure });
      } else {
        run.status = "completed";
        this.events.emit({ ...this.eventBase(run), type: "run.completed", durationMs, usage });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;
      if (this.abortController.signal.aborted) {
        run.status = "aborted";
        this.events.emit({ ...this.eventBase(run), type: "run.aborted", durationMs, reason: "Current turn interrupted." });
      } else {
        run.status = "failed";
        agent.recordError(error);
        this.events.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: message });
      }
    } finally {
      this.pendingPermission = undefined;
      this.abortController = undefined;
      this.activeRun = undefined;
      this.tools.clear();
      this.permissionRequestIds.clear();
      void assistantContent;
    }
  }

  private handleAgentEvent(
    run: ActiveRunSnapshot,
    event: AgentSessionEvent,
    reasoningActive: boolean
  ): { reasoningActive: boolean; assistantContent?: string; failure?: string; usage?: SessionUsage } {
    if (event.type === "status") {
      run.status = event.status === "waiting_permission" ? "waiting_permission" : event.status === "running" ? "running" : event.status === "error" ? "failed" : event.status;
      if (event.status === "thinking" && !reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.started", messageId: run.messageId, status: "正在分析任务" });
        return { reasoningActive: true };
      }
      return { reasoningActive, failure: event.status === "error" ? "Agent run failed." : undefined };
    }

    if (event.type === "sdk") {
      const part = event.part;
      if (part.type === "start-step" && !reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.started", messageId: run.messageId, status: "正在继续处理" });
        return { reasoningActive: true };
      }
      if (part.type === "reasoning-delta") {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.delta", messageId: run.messageId, content: part.text });
        return { reasoningActive: true };
      }
      if (part.type === "text-delta") {
        if (reasoningActive) {
          this.events.emit({ ...this.eventBase(run), type: "reasoning.completed", messageId: run.messageId, status: "分析完成" });
        }
        this.events.emit({ ...this.eventBase(run), type: "assistant.delta", messageId: run.messageId, content: part.text });
        return { reasoningActive: false, assistantContent: part.text };
      }
      if (part.type === "tool-result") {
        this.completeTool(run, part.toolCallId, part.toolName, part.output);
        return { reasoningActive };
      }
      if (part.type === "tool-error") {
        this.failTool(run, part.toolCallId, part.toolName, String(part.error));
        return { reasoningActive, failure: String(part.error) };
      }
      return { reasoningActive };
    }

    if (event.type === "tool-started") {
      if (reasoningActive) {
        this.events.emit({ ...this.eventBase(run), type: "reasoning.completed", messageId: run.messageId, status: "分析完成" });
      }
      run.status = "running";
      this.tools.set(event.toolCallId, {
        tool: event.tool,
        args: event.args,
        display: event.display,
        startedAtMs: Date.now()
      });
      this.events.emit({
        ...this.eventBase(run),
        type: "tool.started",
        toolCallId: event.toolCallId,
        tool: event.tool,
        args: event.args,
        description: event.description,
        display: event.display
      });
      this.events.emit({
        ...this.eventBase(run),
        type: "reasoning.status",
        messageId: run.messageId,
        status: publicToolStatus(event.tool, event.display)
      });
      if (event.display?.kind === "command") {
        this.events.emit({
          ...this.eventBase(run),
          type: "command.started",
          toolCallId: event.toolCallId,
          command: event.display.command,
          cwd: event.display.cwd
        });
      }
      return { reasoningActive: false };
    }

    if (event.type === "tool-progress") {
      this.events.emit({ ...this.eventBase(run), type: "tool.progress", toolCallId: event.toolCallId, tool: event.tool, update: event.update });
      const activeTool = this.tools.get(event.toolCallId);
      if (activeTool?.display?.kind === "command" && event.update.text) {
        const stream = event.update.kind === "stdout" || event.update.kind === "stderr" ? event.update.kind : "status";
        this.events.emit({ ...this.eventBase(run), type: "command.output", toolCallId: event.toolCallId, stream, content: event.update.text });
      }
      return { reasoningActive };
    }

    if (event.type === "permission-requested") {
      run.status = "waiting_permission";
      return { reasoningActive };
    }

    if (event.type === "permission-result") {
      run.status = "running";
      const requestId = this.permissionRequestIds.get(event.toolCallId) ?? randomUUID();
      this.events.emit({
        ...this.eventBase(run),
        type: "permission.resolved",
        requestId,
        toolCallId: event.toolCallId,
        tool: event.request.tool,
        approved: event.result.approved,
        scope: event.result.scope,
        message: event.result.message
      });
      return { reasoningActive };
    }

    if (event.type === "error") return { reasoningActive, failure: event.message };
    if (event.type === "done") {
      this.events.emit({ ...this.eventBase(run), type: "assistant.completed", messageId: run.messageId, content: event.content });
      return { reasoningActive, assistantContent: event.content, usage: event.usage };
    }
    return { reasoningActive };
  }

  private async waitForPermission(run: ActiveRunSnapshot, request: AgentPermissionEventRequest): Promise<AgentPermissionResult> {
    const toolCallId = request.toolCallId;
    const requestId = randomUUID();
    this.permissionRequestIds.set(toolCallId, requestId);
    const result = await new Promise<AgentPermissionResult>((resolve) => {
      this.pendingPermission = {
        sessionId: run.sessionId,
        runId: run.runId,
        requestId,
        toolCallId,
        request: { ...request },
        resolve
      };
      this.events.emit({ ...this.eventBase(run), type: "permission.requested", requestId, toolCallId, request: { ...request } });
    });
    return result;
  }

  private completeTool(run: ActiveRunSnapshot, toolCallId: string, tool: string, result: unknown): void {
    const active = this.tools.get(toolCallId);
    const durationMs = active ? Date.now() - active.startedAtMs : readNumber(result, "durationMs");
    this.events.emit({ ...this.eventBase(run), type: "tool.completed", toolCallId, tool, result, durationMs });
    const display = active?.display;
    if (display?.kind === "command") {
      this.events.emit({
        ...this.eventBase(run),
        type: "command.completed",
        toolCallId,
        command: display.command,
        cwd: display.cwd,
        exitCode: readNumber(result, "exitCode"),
        durationMs
      });
    }
    if (display?.kind === "file_io" && display.path) {
      if (display.operation === "read") {
        this.events.emit({ ...this.eventBase(run), type: "file.read", toolCallId, path: display.path, lineStart: undefined, lineEnd: undefined });
      } else if ((display.operation === "write" || display.operation === "edit") && !isFailedResult(result)) {
        this.events.emit({
          ...this.eventBase(run),
          type: "file.changed",
          toolCallId,
          path: display.path,
          operation: display.operation,
          summary: readString(result, "changeSummary")
        });
      }
    }
    const diff = tool === "git_diff" ? readString(result, "output") : readString(result, "diffPreview");
    if (diff) {
      this.events.emit({
        ...this.eventBase(run),
        type: "diff.created",
        toolCallId,
        diff,
        path: display?.kind === "file_io" ? display.path : undefined
      });
    }
    this.tools.delete(toolCallId);
  }

  private failTool(run: ActiveRunSnapshot, toolCallId: string, tool: string, error: string): void {
    const active = this.tools.get(toolCallId);
    const durationMs = active ? Date.now() - active.startedAtMs : undefined;
    this.events.emit({ ...this.eventBase(run), type: "tool.failed", toolCallId, tool, error, durationMs });
    this.tools.delete(toolCallId);
  }

  private eventBase(run: Pick<ActiveRunSnapshot, "sessionId" | "runId">): Pick<AgentHostEvent, "sessionId" | "runId" | "timestamp"> {
    return { sessionId: run.sessionId, runId: run.runId, timestamp: new Date().toISOString() };
  }

  private standaloneRun(sessionId: string, runId: string, input: string): ActiveRunSnapshot {
    return {
      sessionId,
      runId,
      messageId: randomUUID(),
      input,
      mode: "chat",
      status: "running",
      startedAt: new Date().toISOString()
    };
  }
}

export async function createInteractiveAgentRuntime(workspaceRoot: string, options?: CommandRuntimeOptions): Promise<InteractiveAgentRuntime> {
  return new InteractiveAgentRuntime(await createCommandRuntime(workspaceRoot, options));
}

function publicToolStatus(tool: string, display: ToolInputDisplay | undefined): string {
  if (display?.kind === "command") return "正在运行命令";
  if (display?.kind === "file_io") {
    if (display.operation === "read") return "正在读取文件";
    if (display.operation === "write" || display.operation === "edit") return "正在修改文件";
    if (display.operation === "search" || display.operation === "grep") return "正在搜索项目";
    if (display.operation === "git") return "正在检查 Git 状态";
  }
  return `正在执行 ${tool}`;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function isFailedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.error === "string" || record.status === "denied";
}
