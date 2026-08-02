/**
 * 交互端共享的 slash command 注册表与运行时命令执行器。
 *
 * 注册表是 Desktop、TUI 的唯一命令声明来源；只涉及界面布局的命令仍由对应前端处理，
 * 会读取或修改 Agent/runtime 状态的命令统一在这里执行。
 */
import { randomUUID } from "node:crypto";
import { formatSubagentAgentList } from "../extensions/report.js";
import { redactSecrets } from "../utils/secrets.js";
import { formatSubagentTaskReport } from "./subagentTaskReport.js";
import type { CommandRuntime } from "./CommandRuntime.js";
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
  services: CommandRuntime,
  input: string,
  source: CommandSurface
): Promise<RuntimeCommandResult | undefined> {
  const [command = "", ...args] = input.trim().replace(/^\/+/, "/").split(/\s+/);
  if (command === "/status") {
    const snapshot = runtime.getSnapshot();
    const info = snapshot.info;
    return result(command, "Status", [
      `Model: ${info.modelLabel} (${info.reasoningLabel})`,
      `Permissions: ${snapshot.permissionMode}`,
      "",
      services.extensionReport()
    ].join("\n"));
  }
  if (command === "/context") return result(command, "Context", await services.agent.contextReport());
  if (command === "/usage") return result(command, "Usage", services.agent.usageReport());
  if (command === "/mcp") {
    if (args[0]?.toLowerCase() !== "reconnect") {
      return result(command, "MCP", services.extensionReport("mcp").replace(/^MCP\n/, ""));
    }
    const serverName = args[1]?.trim();
    if (!serverName || args.length !== 2) throw new Error("Usage: /mcp reconnect <server>");
    const status = await runtime.runExclusiveOperation(
      "mcp",
      async () => await services.mcp.reconnectServer(serverName)
    );
    return result(
      command,
      "MCP",
      status.connected
        ? `Reconnected ${serverName} (${String(status.toolNames.length)} tools).`
        : `Reconnect failed for ${serverName}: ${status.lastError ?? "unknown error"}`
    );
  }
  if (command === "/skills") return result(command, "[Skills]", services.extensionReport("skills").replace(/^Skills\n/, ""));
  if (command === "/plugins") return result(command, "Plugins", services.extensionReport("plugins").replace(/^Plugins\n/, ""));
  if (command === "/memory") {
    return result(
      command,
      "Memory",
      await runtime.runExclusiveOperation("memory", async () => await services.agent.runMemoryCommand(args))
    );
  }
  if (command === "/subagent") return await executeSubagentCommand(runtime, services, command, args, source);
  if (command === "/review") {
    const task = args.join(" ").trim()
      || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    return result(command, "Code Review", await runForegroundSubagent(runtime, services, task) || "No review findings.");
  }
  if (command === "/compact") {
    return result(command, "Compact", await runtime.compactConversation(args.join(" ").trim() || undefined));
  }
  if (command === "/undo") {
    const checkpointStore = services.checkpoints;
    const checkpoints = checkpointStore ? await checkpointStore.list() : [];
    if (!checkpoints.length) {
      return result(command, "Undo", "No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
    }
    if (args[0] === "list") {
      return result(command, "Checkpoints", checkpoints.map((entry) => `${entry.id}  ${entry.createdAt}  ${entry.label}`).join("\n"));
    }
    if (!checkpointStore) {
      throw new Error("Checkpoints need a git repository; this workspace is not one.");
    }
    const summary = await runtime.runExclusiveOperation(
      "checkpoint",
      async () => await checkpointStore.restore(args[0] ?? "latest")
    );
    const moved = summary.movedAside.length
      ? `\nMoved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}:\n${summary.movedAside.join("\n")}`
      : "";
    return result(command, "Undo", `Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).${moved}`);
  }
  return undefined;
}

async function executeSubagentCommand(
  runtime: InteractiveAgentRuntime,
  services: CommandRuntime,
  command: string,
  args: string[],
  source: CommandSurface
): Promise<RuntimeCommandResult> {
  const action = args[0]?.toLowerCase();
  if (action === "agents") {
    return result(command, "Subagent", formatSubagentAgentList(await services.listSubagentAgents()));
  }
  if (action === "status") {
    return result(command, "Subagent", formatSubagentTaskReport(services.subagents?.listSnapshots() ?? []));
  }
  if (action === "cancel") {
    const taskId = args[1]?.trim();
    if (!taskId) throw new Error("Usage: /subagent cancel <task-id>");
    const cancelled = services.subagents?.cancelTask(taskId, `Cancelled from the ${source}.`) ?? false;
    return result(command, "Subagent", cancelled
      ? `Cancelled subagent task ${taskId}.`
      : `No active subagent task found for ${taskId}.`);
  }
  if (action === "start") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent start <read-only task>");
    const submitted = runtime.startBackgroundOperation(
      "subagent",
      (signal) => services.startSubagentTask(task, { signal })
    );
    void submitted.completion.catch(() => undefined);
    return result(command, "Subagent", `Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
  }
  const task = args.join(" ").trim();
  if (!task) {
    return result(command, "Subagent", "Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id> | agents");
  }
  return result(command, "Subagent", await runForegroundSubagent(runtime, services, task) || "Subagent returned no text.");
}

async function runForegroundSubagent(
  runtime: InteractiveAgentRuntime,
  services: CommandRuntime,
  task: string
): Promise<string> {
  try {
    return await runtime.runExclusiveOperation(
      "subagent",
      async (signal) => await services.startSubagentTask(task, { taskId: randomUUID(), signal }).completion
    );
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(redactSecrets(String(error)));
    const publicMessage = redactSecrets(error.message);
    if (publicMessage === error.message) throw error;
    try {
      Object.defineProperty(error, "message", { value: publicMessage, configurable: true });
    } catch {
      const publicError = new Error(publicMessage);
      publicError.name = error.name;
      throw publicError;
    }
    throw error;
  }
}

function result(command: string, title: string, content: string): RuntimeCommandResult {
  return { command, title, content };
}
