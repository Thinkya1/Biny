import assert from "node:assert/strict";
import type { AgentModel, AgentTool, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { agentLoop } from "../src/agent/core/agentLoop.js";

async function main(): Promise<void> {
  const calls: ModelStreamContext[] = [];
  const model: AgentModel = {
    provider: "test",
    modelId: "test-model",
    async stream(context): Promise<AsyncIterable<ModelStreamEvent>> {
      calls.push({ ...context, messages: [...context.messages], tools: [...context.tools] });
      if (calls.length === 1) {
        return events([
          { type: "start" },
          { type: "text-delta", text: "reading" },
          { type: "tool-call", id: "call-1", name: "read", arguments: { path: "README.md" } },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }
        ]);
      }
      return events([
        { type: "start" },
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop", usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 } }
      ]);
    }
  };
  const tool: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    },
    async execute(_toolCallId, args) {
      return { content: [{ type: "text", text: `content for ${String(args.path)}` }], details: { ok: true } };
    }
  };
  const received: string[] = [];
  for await (const event of agentLoop([{ role: "user", content: "inspect README.md" }], {
    messages: [],
    tools: [tool]
  }, { model, tools: [tool], maxSteps: 4 })) {
    received.push(event.type);
  }
  assert.deepEqual(calls.length, 2);
  assert.deepEqual(calls[1]?.messages.at(-1)?.role, "toolResult");
  assert.equal(received.includes("tool_execution_start"), true);
  assert.equal(received.includes("tool_execution_end"), true);
  assert.equal(received.filter((type) => type === "turn_end").length, 2);
  console.log("agent core tests passed");
}

async function* events(events: ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const event of events) yield event;
}

await main();
