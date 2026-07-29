/**
 * 交互端共享的 slash command 注册表与运行时命令执行器。
 *
 * 注册表是 Desktop、TUI 的唯一命令声明来源；只涉及界面布局的命令仍由对应前端处理，
 * 会读取或修改 Agent/runtime 状态的命令统一在这里执行。
 */
import { formatSubagentAgentList } from "../extensions/report.js";
import { formatSubagentTaskReport } from "./subagentTaskReport.js";
import type { InteractiveAgentRuntime } from "./InteractiveAgentRuntime.js";
import type { CommandSurface } from "./commandRegistry.js";

export interface RuntimeCommandResult {
  command: string;
  title: string;
  content: string;
}

/**
 * 执行不依赖具体界面布局的命令。返回 undefined 表示该命令应由前端本地处理。
 */
export async function executeRuntimeCommand(
  runtime: InteractiveAgentRuntime,
  input: string,
  source: CommandSurface
): Promise<RuntimeCommandResult | undefined> {
  const [command = "", ...args] = input.trim().replace(/^\/+/, "/").split(/\s+/);
  if (command === "/status") {
    const info = runtime.getInfo();
    return result(command, "Status", [
      `Model: ${info.modelLabel} (${info.reasoningLabel})`,
      `Permissions: ${runtime.getPermissionMode()}`,
      "",
      runtime.extensionReport()
    ].join("\n"));
  }
  if (command === "/context") return result(command, "Context", await runtime.contextReport());
  if (command === "/usage") return result(command, "Usage", runtime.usageReport());
  if (command === "/mcp") {
    if (args[0]?.toLowerCase() !== "reconnect") {
      return result(command, "MCP", runtime.extensionReport("mcp").replace(/^MCP\n/, ""));
    }
    const serverName = args[1]?.trim();
    if (!serverName || args.length !== 2) throw new Error("Usage: /mcp reconnect <server>");
    const status = await runtime.reconnectMcpServer(serverName);
    return result(
      command,
      "MCP",
      status.connected
        ? `Reconnected ${serverName} (${String(status.toolNames.length)} tools).`
        : `Reconnect failed for ${serverName}: ${status.lastError ?? "unknown error"}`
    );
  }
  if (command === "/skills") return result(command, "Skills", runtime.extensionReport("skills").replace(/^Skills\n/, ""));
  if (command === "/plugins") return result(command, "Plugins", runtime.extensionReport("plugins").replace(/^Plugins\n/, ""));
  if (command === "/memory") return result(command, "Memory", await runtime.runMemoryCommand(args));
  if (command === "/subagent") return await executeSubagentCommand(runtime, command, args, source);
  if (command === "/review") {
    const task = args.join(" ").trim()
      || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    return result(command, "Code Review", await runtime.runSubagentTask(task) || "No review findings.");
  }
  if (command === "/compact") {
    return result(command, "Compact", await runtime.compactConversation(args.join(" ").trim() || undefined));
  }
  if (command === "/continue") {
    const interrupted = await runtime.interruptedTurn();
    if (!interrupted) return result(command, "Continue", "No interrupted turn to continue.");
    const outcome = await runtime.continueInterruptedTurn();
    const content = outcome?.status === "completed"
      ? `Continued after ${String(interrupted.completedSteps)} completed step(s).`
      : outcome?.error ?? "The interrupted turn did not complete.";
    return result(command, "Continue", content);
  }
  if (command === "/undo") {
    const checkpoints = await runtime.listCheckpoints();
    if (!checkpoints.length) {
      return result(command, "Undo", "No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
    }
    if (args[0] === "list") {
      return result(command, "Checkpoints", checkpoints.map((entry) => `${entry.id}  ${entry.createdAt}  ${entry.label}`).join("\n"));
    }
    const summary = await runtime.restoreCheckpoint(args[0] ?? "latest");
    const moved = summary.movedAside.length
      ? `\nMoved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}:\n${summary.movedAside.join("\n")}`
      : "";
    return result(command, "Undo", `Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).${moved}`);
  }
  return undefined;
}

async function executeSubagentCommand(
  runtime: InteractiveAgentRuntime,
  command: string,
  args: string[],
  source: CommandSurface
): Promise<RuntimeCommandResult> {
  const action = args[0]?.toLowerCase();
  if (action === "agents") {
    return result(command, "Subagent", formatSubagentAgentList(await runtime.listSubagentAgents()));
  }
  if (action === "status") {
    return result(command, "Subagent", formatSubagentTaskReport(runtime.listSubagentTasks()));
  }
  if (action === "cancel") {
    const taskId = args[1]?.trim();
    if (!taskId) throw new Error("Usage: /subagent cancel <task-id>");
    const cancelled = runtime.cancelSubagentTask(taskId, `Cancelled from the ${source}.`);
    return result(command, "Subagent", cancelled
      ? `Cancelled subagent task ${taskId}.`
      : `No active subagent task found for ${taskId}.`);
  }
  if (action === "start") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent start <read-only task>");
    const submitted = runtime.startSubagentTask(task);
    void submitted.completion.catch(() => undefined);
    return result(command, "Subagent", `Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
  }
  const task = args.join(" ").trim();
  if (!task) {
    return result(command, "Subagent", "Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id> | agents");
  }
  return result(command, "Subagent", await runtime.runSubagentTask(task) || "Subagent returned no text.");
}

function result(command: string, title: string, content: string): RuntimeCommandResult {
  return { command, title, content };
}
