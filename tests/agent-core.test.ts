import assert from "node:assert/strict";
import type { AgentAssistantMessage, AgentModel, AgentTool, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { agentLoop } from "../src/agent/core/agentLoop.js";

async function main(): Promise<void> {
  await testAssistantDeltasAreForwardedBeforeProviderCompletes();
  await testModelErrorRecoveryRetriesBeforeAnyDelta();
  await testModelStreamWithoutFinishFails();
  await testNextTurnRefreshesModelAndTools();
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

async function testModelStreamWithoutFinishFails(): Promise<void> {
  const model: AgentModel = {
    provider: "truncated-test",
    modelId: "truncated-model",
    stream: async () => events([
      { type: "start" },
      { type: "text-delta", text: "partial answer" }
    ])
  };
  let assistant: AgentAssistantMessage | undefined;
  let errorMessage = "";
  for await (const event of agentLoop([{ role: "user", content: "answer" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 1
  })) {
    if (event.type === "error") errorMessage = event.error;
    if (event.type === "message_end" && event.message.role === "assistant") assistant = event.message;
  }
  assert.match(errorMessage, /ended without a finish event/u);
  assert.equal(assistant?.stopReason, "error");
  assert.equal(assistant?.content.find((part) => part.type === "text")?.text, "partial answer");
}

async function testModelErrorRecoveryRetriesBeforeAnyDelta(): Promise<void> {
  let requests = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "recovery-model",
    async stream(): Promise<AsyncIterable<ModelStreamEvent>> {
      requests += 1;
      if (requests === 1) throw new Error("maximum context length exceeded");
      return events([{ type: "text-delta", text: "recovered" }, { type: "finish", reason: "stop" }]);
    }
  };
  const received: string[] = [];
  for await (const event of agentLoop([{ role: "user", content: "recover" }], { messages: [], tools: [] }, {
    model,
    tools: [],
    maxSteps: 1,
    recoverFromModelError: async (_error, context) => {
      context.messages.splice(0, context.messages.length, { role: "user", content: "compacted" });
      return { reason: "context_overflow", attempt: 1, compactedMessages: 4 };
    }
  })) received.push(event.type);
  assert.equal(requests, 2);
  assert.equal(received.includes("model_retry"), true);
}

async function testNextTurnRefreshesModelAndTools(): Promise<void> {
  const firstTool: AgentTool = {
    name: "first_tool",
    description: "First tool.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "first result" }] })
  };
  const nextTool: AgentTool = { ...firstTool, name: "next_tool", description: "Next tool." };
  const firstModel: AgentModel = {
    provider: "test",
    modelId: "first-model",
    stream: async () => events([
      { type: "tool-call", id: "first-call", name: "first_tool", arguments: {} },
      { type: "finish", reason: "tool-calls" }
    ])
  };
  let refreshedContext: ModelStreamContext | undefined;
  const nextModel: AgentModel = {
    provider: "test",
    modelId: "next-model",
    stream: async (context) => {
      refreshedContext = context;
      return events([{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }]);
    }
  };
  for await (const _event of agentLoop([{ role: "user", content: "refresh" }], { messages: [], tools: [firstTool] }, {
    model: firstModel,
    tools: [firstTool],
    maxSteps: 2,
    prepareNextTurn: async ({ context }) => ({ context: { ...context, systemPrompt: "refreshed" }, model: nextModel, tools: [nextTool] })
  })) {
    // Drain the loop.
  }
  assert.equal(refreshedContext?.systemPrompt, "refreshed");
  assert.deepEqual(refreshedContext?.tools.map((tool) => tool.name), ["next_tool"]);
}

async function testAssistantDeltasAreForwardedBeforeProviderCompletes(): Promise<void> {
  let providerFinished = false;
  let firstDeltaForwarded = false;
  const model: AgentModel = {
    provider: "stream-test",
    modelId: "stream-test-model",
    async stream(): Promise<AsyncIterable<ModelStreamEvent>> {
      return delayedEvents();
    }
  };

  for await (const event of agentLoop([{ role: "user", content: "stream" }], {
    messages: [],
    tools: []
  }, { model, tools: [], maxSteps: 1 })) {
    if (event.type === "message_update" && event.event.type === "text-delta" && event.event.text === "first") {
      firstDeltaForwarded = true;
      assert.equal(providerFinished, false, "the first assistant delta must arrive before the provider finishes");
    }
  }

  assert.equal(firstDeltaForwarded, true);

  async function* delayedEvents(): AsyncGenerator<ModelStreamEvent> {
    yield { type: "start" };
    yield { type: "text-delta", text: "first" };
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    yield { type: "text-delta", text: "second" };
    yield { type: "finish", reason: "stop" };
    providerFinished = true;
  }
}

async function* events(events: ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const event of events) yield event;
}

await main();
