import assert from "node:assert/strict";
import type { ModelMessage } from "../src/agent/core/modelMessage.js";
import { replaySessionEvents, sessionEventsToConversation } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";

function main(): void {
  const signedReasoning = { anthropic: { signature: "opaque-signature" } };
  const events: SessionEvent[] = [
    { type: "user_message", content: "inspect the workspace" },
    {
      type: "tool_call",
      tool: "read_file",
      args: { path: "src/index.ts" },
      toolCallId: "read-1",
      sequence: 1,
      reasoningContent: "Start with the entry point.",
      reasoningProviderOptions: signedReasoning
    },
    { type: "tool_result", tool: "read_file", toolCallId: "read-1", sequence: 1, result: { path: "src/index.ts", content: "export {};" } },
    { type: "tool_call", tool: "run_command", args: { command: "pnpm typecheck" }, toolCallId: "check-1", sequence: 2 }
  ];
  const replay = replaySessionEvents(events);

  assert.equal(replay.recoveredToolResults.length, 1);
  assert.deepEqual(replay.recoveredToolResults[0]?.result, { error: "Tool call was interrupted before completion.", interrupted: true });
  const toolCall = replay.messages.find((message) => hasToolCall(message, "read-1"));
  assert.deepEqual(reasoningProviderOptions(toolCall), signedReasoning);
  assert.equal(replay.messages.some((message) => hasToolResult(message, "check-1")), true);

  const unsigned = sessionEventsToConversation([
    { type: "user_message", content: "old session" },
    { type: "assistant_message", content: "answer", reasoningContent: "unsigned legacy reasoning" }
  ]);
  assert.equal(reasoningProviderOptions(unsigned[1]), undefined);

  // 一步里的多个 reasoning block 各自签名，必须逐块回放，不能拼成一个块共用最后一个签名。
  const firstSignature = { anthropic: { signature: "first-signature" } };
  const secondSignature = { anthropic: { signature: "second-signature" } };
  const multiBlock = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningContent: "first thoughtsecond thought",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "first thought", providerOptions: firstSignature },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.text), ["first thought", "second thought"]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.providerOptions), [firstSignature, secondSignature]);

  // 签名丢失的块不能靠回合级 providerOptions 蒙混过关，只能整块丢弃。
  const partiallySigned = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "redacted block" },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(partiallySigned[1]).map((part) => part.text), ["second thought"]);
}

function hasToolCall(message: ModelMessage, toolCallId: string): boolean {
  return message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId);
}

function hasToolResult(message: ModelMessage, toolCallId: string): boolean {
  return message.role === "tool"
    && message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
}

function reasoningProviderOptions(message: ModelMessage | undefined): unknown {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  return message.content.find((part) => part.type === "reasoning")?.providerOptions;
}

function reasoningParts(message: ModelMessage | undefined): Array<{ text: string; providerOptions?: unknown }> {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => part.type === "reasoning");
}

main();
