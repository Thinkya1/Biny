/**
 * CLI chat 模式的 slash 命令。
 *
 * 命令清单集中在 `CHAT_SLASH_COMMANDS`，帮助、补全和执行都以它为唯一来源。
 * 这里只做参数解析和输出，具体能力都转交 runtime/agent；返回值 false 表示要退出 chat。
 *
 * 注意 `host` 是可选的：交互式 chat 会传入 `InteractiveAgentRuntime`（带运行队列和事件），
 * 非交互场景只有 `CommandRuntime`，因此涉及运行状态的命令要用 `host ?? agent` 的形式回退。
 */
import type { CommandRuntime } from "../../runtime/CommandRuntime.js";
import type { InteractiveAgentRuntime } from "../../runtime/InteractiveAgentRuntime.js";
import { parseThinkingSelection } from "../../llm/ModelManager.js";
import { formatSubagentTaskReport } from "../../runtime/subagentTaskReport.js";
import { formatSubagentAgentList } from "../../extensions/report.js";
import type { SlashCommand } from "../prompt/slashMenu.js";
import { printSessionSummaries } from "./sessions.js";

export const CHAT_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", category: "system" },
  { name: "/clear", description: "Clear the terminal", category: "system" },
  { name: "/context", description: "Show loaded context and budget", category: "system" },
  { name: "/usage", description: "Show SDK token usage and cost", category: "system" },
  { name: "/compact", description: "Compact older conversation history", category: "system" },
  { name: "/model", description: "Switch model and thinking effort", category: "system" },
  { name: "/status", description: "Show model, permissions and extensions", category: "system" },
  { name: "/mcp", description: "List MCP servers and tools, or `reconnect <server>`", category: "extension" },
  { name: "/skills", description: "List available skills (project & global)", category: "extension" },
  { name: "/plugins", description: "List loaded plugins", category: "extension" },
  { name: "/subagent", description: "Run or manage a subagent (start/status/cancel/agents)", category: "extension", requiresArgs: true },
  { name: "/review", description: "Review current changes with a read-only subagent", category: "extension" },
  { name: "/memory", description: "Manage durable project memory (list/show/add/forget)", category: "extension" },
  { name: "/sessions", description: "List recorded sessions", category: "session" },
  { name: "/resume", description: "Continue a previous session", category: "session" },
  { name: "/permissions", description: "View or change permission mode", category: "system" },
  { name: "/approvals", description: "Alias for /permissions", category: "system" },
  { name: "/undo", description: "Restore the workspace from a Biny checkpoint (/undo list to see them)", category: "system" },
  { name: "/continue", description: "Continue a turn that was interrupted mid-run", category: "system" },
  { name: "/fork", description: "Fork a session into a new one (/fork [session] [upToEvent])", category: "system" },
  { name: "/plan", description: "Create a plan without executing tools", category: "plan", requiresArgs: true },
  { name: "/exit", description: "Exit chat", category: "system" },
  { name: "/quit", description: "Exit chat", category: "system" }
];

/** 执行一条 slash 命令；返回 false 表示用户要求退出，其余情况一律返回 true。 */
export async function executeChatSlashCommand(runtime: CommandRuntime, text: string, signal?: AbortSignal, host?: InteractiveAgentRuntime): Promise<boolean> {
  const agent = runtime.agent;
  const [command, ...args] = text.split(/\s+/);

  if (command === "/" || command === "/help") {
    printSlashHelp();
    return true;
  }
  if (command === "/exit" || command === "/quit") return false;
  if (command === "/clear") {
    console.clear();
    return true;
  }
  if (command === "/context") {
    console.log(await agent.contextReport());
    return true;
  }
  if (command === "/usage") {
    console.log(agent.usageReport());
    return true;
  }
  if (command === "/status") {
    console.log(`Model: ${agent.getInfo().modelLabel} (${agent.getInfo().reasoningLabel})`);
    console.log(`Permissions: ${agent.getPermissionMode()}`);
    console.log(runtime.extensionReport());
    return true;
  }
  if (command === "/mcp") {
    if (args[0]?.toLowerCase() === "reconnect") {
      const serverName = args[1]?.trim();
      if (!serverName) {
        console.log("Usage: /mcp reconnect <server>");
        return true;
      }
      const status = await runtime.reconnectMcpServer(serverName);
      console.log(status.connected
        ? `Reconnected ${serverName} (${String(status.toolNames.length)} tools).`
        : `Reconnect failed for ${serverName}: ${status.lastError ?? "unknown error"}`);
      return true;
    }
    console.log(runtime.extensionReport("mcp"));
    return true;
  }
  if (command === "/skills") {
    console.log(runtime.extensionReport("skills"));
    return true;
  }
  if (command === "/plugins") {
    console.log(runtime.extensionReport("plugins"));
    return true;
  }
  if (command === "/subagent") {
    // 子命令：start 异步派发，status/cancel 管理已派发任务，不带子命令则同步跑完再输出。
    const action = args[0]?.toLowerCase();
    if (action === "start") {
      const task = args.slice(1).join(" ").trim();
      if (!task) {
        console.log("Usage: /subagent start <read-only task>");
        return true;
      }
      const submitted = host?.startSubagentTask(task) ?? runtime.startSubagentTask(task);
      console.log(`Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
      return true;
    }
    if (action === "status") {
      console.log(formatSubagentTaskReport(runtime.listSubagentTasks()));
      return true;
    }
    if (action === "cancel") {
      const taskId = args[1]?.trim();
      if (!taskId) {
        console.log("Usage: /subagent cancel <task-id>");
        return true;
      }
      const cancelled = runtime.cancelSubagentTask(taskId, "Cancelled from the CLI.");
      console.log(cancelled ? `Cancelled subagent task ${taskId}.` : `No active subagent task found for ${taskId}.`);
      return true;
    }
    if (action === "agents") {
      console.log(formatSubagentAgentList(await runtime.listSubagentAgents()));
      return true;
    }
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id> | agents");
      return true;
    }
    console.log(await runtime.runSubagentTask(task, { signal }));
    return true;
  }
  if (command === "/memory") {
    console.log(await (host ?? agent).runMemoryCommand(args));
    return true;
  }
  if (command === "/review") {
    const instructions = args.join(" ").trim();
    const task = instructions || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    console.log(await runtime.runSubagentTask(task, { signal }));
    return true;
  }
  if (command === "/compact") {
    console.log(host
      ? await host.compactConversation(args.join(" ").trim() || undefined)
      : await agent.compactConversation(args.join(" ").trim() || undefined, signal));
    return true;
  }
  if (command === "/model") {
    if (!args[0]) {
      const info = agent.getInfo();
      console.log(`Current model: ${info.modelLabel}`);
      console.log(`Thinking: ${info.reasoningLabel}`);
      console.log("Available models:");
      for (const model of agent.listModels()) {
        const current = model.alias === info.modelAlias ? " <- current" : "";
        // 配了但没有凭据的别名仍然列出来，让用户知道有这个模型，只是标注出来提示需要凭据，
        // 而不是悄悄隐藏或让它看起来可以直接切换。
        const unavailable = model.available ? "" : "  (needs credentials)";
        console.log(`  ${model.alias.padEnd(24)}${model.provider}  ${model.efforts.join("/") || "no thinking"}${unavailable}${current}`);
      }
      console.log("Usage: /model <alias> [off|high|max]");
      return true;
    }
    const info = await (host ?? agent).switchModel(args[0], parseThinkingSelection(args[1]));
    console.log(`Switched model: ${info.modelLabel} (thinking: ${info.reasoningLabel})`);
    return true;
  }
  if (command === "/sessions") {
    printSessionSummaries(await agent.listSessions());
    return true;
  }
  if (command === "/permissions" || command === "/approvals") {
    console.log(await (host ?? agent).runPermissionCommand(args));
    return true;
  }
  if (command === "/fork") {
    const upTo = args[1] === undefined ? undefined : Number.parseInt(args[1], 10);
    if (args[1] !== undefined && !Number.isSafeInteger(upTo)) {
      console.log("Usage: /fork [session] [upToEvent]");
      return true;
    }
    const forked = await runtime.forkSession(args[0], upTo);
    console.log(`Forked ${forked.sourceSessionId} at ${String(forked.events)} event(s) into ${forked.sessionId}`);
    console.log(forked.filePath);
    return true;
  }
  if (command === "/continue") {
    const interrupted = await runtime.interruptedTurn();
    if (!interrupted) {
      console.log("No interrupted turn to continue.");
      return true;
    }
    console.log(`Continuing after ${String(interrupted.completedSteps)} completed step(s): ${interrupted.prompt}`);
    for await (const event of agent.continueInterruptedTurn()) {
      if (event.type === "done") console.log(event.content);
    }
    return true;
  }
  if (command === "/undo") {
    const checkpoints = await runtime.listCheckpoints();
    if (!checkpoints.length) {
      console.log("No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
      return true;
    }
    if (args[0] === "list") {
      for (const entry of checkpoints) console.log(`${entry.id}  ${entry.createdAt}  ${entry.label}`);
      return true;
    }
    const summary = await runtime.restoreCheckpoint(args[0] ?? "latest");
    console.log(`Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).`);
    if (summary.movedAside.length) {
      console.log(`Moved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}: ${summary.movedAside.join(", ")}`);
    }
    return true;
  }
  if (command === "/resume") {
    if (!args[0]) {
      printSessionSummaries(await agent.listSessions());
      return true;
    }
    const resumed = await (host ? host.resumeSession(args[0]) : agent.resume(args[0]));
    console.log(`Resumed session: ${resumed.filePath}`);
    return true;
  }
  if (command === "/plan") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Usage: /plan <task>");
      return true;
    }
    console.log(host
      ? await host.createPlan(task, undefined, signal)
      : await agent.createPlan(task, undefined, signal));
    return true;
  }

  console.log(`Unknown command: ${command}`);
  printSlashHelp();
  return true;
}

/** readline 补全回调：无匹配时给出全部命令，避免用户敲错前缀后什么提示都没有。 */
export function completeChatSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const names = CHAT_SLASH_COMMANDS.map((command) => command.name);
  const hits = names.filter((command) => command.startsWith(line));
  return [hits.length ? hits : names, line];
}

function printSlashHelp(): void {
  console.log("Available commands:");
  for (const command of CHAT_SLASH_COMMANDS) console.log(`  ${command.name.padEnd(16)}${command.description}`);
}
