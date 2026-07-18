import type { McpServerStatus } from "./mcp.js";
import type { ToolSource } from "../tools/types.js";

export interface ExtensionStatus {
  mcp: McpServerStatus[];
  skills: string[];
  plugins: string[];
  subagent: {
    enabled: boolean;
    maxSteps: number;
    maxOutputTokens: number;
    maxConcurrentSubagents: number;
    maxPendingSubagents: number;
    timeoutMs: number;
    model?: string;
    maxCostUsd?: number;
    allowedTools: string[];
  };
  toolScheduling: {
    maxConcurrentTools: number;
    maxQueuedToolCalls: number;
  };
  toolCounts: Record<ToolSource, number>;
}

export type ExtensionSection = "all" | "mcp" | "skills" | "plugins";

export function createToolCounts(entries: Array<{ source: ToolSource }>): Record<ToolSource, number> {
  const counts: Record<ToolSource, number> = {
    builtin: 0,
    mcp: 0,
    skill: 0,
    plugin: 0,
    subagent: 0
  };
  for (const entry of entries) counts[entry.source] += 1;
  return counts;
}

export function formatExtensionReport(status: ExtensionStatus, section: ExtensionSection = "all"): string {
  if (section === "mcp") return formatMcpReport(status.mcp);
  if (section === "skills") return formatPathReport("Skills", status.skills, "No skills loaded.");
  if (section === "plugins") return formatPathReport("Plugins", status.plugins, "No plugins loaded.");

  const counts = status.toolCounts;
  return [
    "Extensions",
    "",
    formatMcpReport(status.mcp),
    "",
    formatPathReport("Skills", status.skills, "No skills loaded."),
    "",
    formatPathReport("Plugins", status.plugins, "No plugins loaded."),
    "",
    "Subagent",
    status.subagent.enabled
      ? [
        `  enabled · delegate_task · read-only · max ${String(status.subagent.maxSteps)} steps · ${String(status.subagent.maxOutputTokens)} output tokens`,
        `  concurrency ${String(status.subagent.maxConcurrentSubagents)} · queue cap ${String(status.subagent.maxPendingSubagents)} · timeout ${String(status.subagent.timeoutMs)}ms · model ${status.subagent.model ?? "current"}`,
        `  cost stop threshold ${status.subagent.maxCostUsd === undefined ? "not set" : `$${status.subagent.maxCostUsd.toFixed(6)}`} · tools ${status.subagent.allowedTools.join(", ")}`
      ].join("\n")
      : "  disabled",
    "",
    "Tools",
    `  scheduling concurrency ${String(status.toolScheduling.maxConcurrentTools)} · queue cap ${String(status.toolScheduling.maxQueuedToolCalls)}`,
    `  builtin ${String(counts.builtin)} · mcp ${String(counts.mcp)} · plugin ${String(counts.plugin)} · subagent ${String(counts.subagent)}`
  ].join("\n");
}

function formatMcpReport(servers: McpServerStatus[]): string {
  if (!servers.length) return "MCP\n  No MCP servers configured.";
  const lines = ["MCP"];
  for (const server of servers) {
    if (!server.enabled) {
      lines.push(`  - ${server.name} · disabled`);
      continue;
    }
    const state = server.connected ? "connected" : "disconnected";
    lines.push(`  ${server.connected ? "✓" : "!"} ${server.name} · ${state} · ${String(server.toolNames.length)} tools`);
    for (const toolName of server.toolNames) lines.push(`    ${toolName}`);
  }
  return lines.join("\n");
}

function formatPathReport(title: string, paths: string[], empty: string): string {
  return [title, ...(paths.length ? paths.map((filePath) => `  ${filePath}`) : [`  ${empty}`])].join("\n");
}
