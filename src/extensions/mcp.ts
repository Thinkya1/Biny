import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentConfig, McpServerConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { JsonObjectSchema } from "../tools/schema.js";
import type { Tool, ToolRisk } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";
import { z } from "zod";

export interface McpServerStatus {
  name: string;
  command: string;
  enabled: boolean;
  connected: boolean;
  toolNames: string[];
}

export class McpToolHost {
  private readonly clients: Client[] = [];
  private readonly servers = new Map<string, McpServerStatus>();

  async connectConfiguredServers(workspaceRoot: string, config: AgentConfig, registry: ToolRegistry): Promise<void> {
    try {
      for (const [serverName, serverConfig] of Object.entries(config.extensions.mcp)) {
        const status: McpServerStatus = {
          name: serverName,
          command: serverConfig.command,
          enabled: serverConfig.enabled,
          connected: false,
          toolNames: []
        };
        this.servers.set(serverName, status);
        if (!serverConfig.enabled) continue;
        status.toolNames = await this.connectServer(workspaceRoot, serverName, serverConfig, registry);
        status.connected = true;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  listServers(): McpServerStatus[] {
    return [...this.servers.values()].map((server) => ({ ...server, toolNames: [...server.toolNames] }));
  }

  async close(): Promise<void> {
    const clients = this.clients.splice(0, this.clients.length);
    await Promise.all(clients.map(async (client) => {
      try {
        await client.close();
      } catch {
        // Closing an already exited MCP process is best effort.
      }
    }));
    for (const server of this.servers.values()) server.connected = false;
  }

  private async connectServer(workspaceRoot: string, serverName: string, serverConfig: McpServerConfig, registry: ToolRegistry): Promise<string[]> {
    const client = new Client({ name: "biny", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env,
      cwd: resolveWorkingDirectory(workspaceRoot, serverConfig.cwd),
      stderr: serverConfig.stderr
    } as StdioServerParameters);
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const toolNames = listed.tools.map((mcpTool) => {
        registry.registerMcpTool(createMcpTool(serverName, client, mcpTool));
        return `mcp_${normalizeName(serverName)}_${normalizeName(mcpTool.name)}`;
      });
      this.clients.push(client);
      return toolNames;
    } catch (error) {
      try {
        await client.close();
      } catch {
        // The original connection error is more useful than a close error.
      }
      throw new Error(`Failed to connect MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function createMcpTool(
  serverName: string,
  client: Client,
  definition: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
): Tool {
  const name = `mcp_${normalizeName(serverName)}_${normalizeName(definition.name)}`;
  const risk: ToolRisk = definition.annotations?.readOnlyHint ? "read" : definition.annotations?.destructiveHint ? "write" : "execute";
  return {
    name,
    description: `[MCP ${serverName}] ${definition.description ?? definition.name}`,
    parameters: definition.inputSchema as unknown as JsonObjectSchema,
    schema: z.unknown(),
    source: "mcp",
    capability: `mcp:${serverName}`,
    risk,
    resolveExecution(args: unknown) {
      return {
        accesses: ToolAccesses.all(),
        display: { kind: "generic", summary: `MCP ${serverName}/${definition.name}`, detail: args },
        description: definition.description ?? `Call MCP tool ${definition.name}`,
        approvalRule: `mcp:${serverName}:${definition.name}`,
        async execute(context: { signal?: AbortSignal }): Promise<unknown> {
          const result = await client.callTool({
            name: definition.name,
            arguments: asArguments(args)
          }, undefined, { signal: context.signal });
          return normalizeMcpResult(result);
        }
      };
    }
  };
}

function normalizeMcpResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return result.isError ? { error: text } : text;
  }
  return result;
}

function asArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 42) || "tool";
}

function resolveWorkingDirectory(workspaceRoot: string, configuredPath: string | undefined): string | undefined {
  if (!configuredPath) return workspaceRoot;
  const absolute = path.resolve(workspaceRoot, configuredPath);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`MCP cwd must stay inside workspace: ${configuredPath}`);
  return absolute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
