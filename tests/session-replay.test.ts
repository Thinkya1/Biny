import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agent/core/types.js";
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
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.providerMetadata), [firstSignature, secondSignature]);

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

  const canonicalAssistant = {
    role: "assistant" as const,
    content: [
      { type: "reasoning" as const, text: "signed thought", providerMetadata: { signature: "sig-1" } },
      { type: "toolCall" as const, id: "call-1", name: "read_file", arguments: { path: "a.ts" } }
    ],
    stopReason: "tool-calls" as const
  };
  const canonicalResult = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text" as const, text: "file body" }],
    details: { content: "file body" }
  };
  assert.deepEqual(replaySessionEvents([
    { type: "user_message", content: "read it" },
    { type: "agent_message", message: canonicalAssistant },
    { type: "tool_call", tool: "read_file", args: { path: "a.ts" }, toolCallId: "call-1" },
    { type: "tool_result", tool: "read_file", result: { content: "legacy projection" }, toolCallId: "call-1" },
    { type: "agent_message", message: canonicalResult },
    { type: "assistant_message", content: "legacy projection" },
    { type: "user_message", content: "continue" },
    { type: "assistant_message", content: "legacy-only fallback" }
  ]).messages, [
    { role: "user", content: "read it" },
    canonicalAssistant,
    canonicalResult,
    { role: "user", content: "continue" },
    { role: "assistant", content: [{ type: "text", text: "legacy-only fallback" }] }
  ]);

  const tree = replaySessionEvents([
    { type: "user_message", content: "root", messageId: "u1" },
    { type: "agent_message", message: canonicalAssistant, messageId: "a1", parentMessageId: "u1" },
    { type: "agent_message", message: canonicalResult, messageId: "t1", parentMessageId: "a1" }
  ]).messageTree;
  assert.deepEqual(tree.map((node) => [node.id, node.parentId, node.message.role]), [
    ["u1", undefined, "user"],
    ["a1", "u1", "assistant"],
    ["t1", "a1", "toolResult"]
  ]);
}

function hasToolCall(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "assistant"
    && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId);
}

function hasToolResult(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "toolResult" && message.toolCallId === toolCallId;
}

function reasoningProviderOptions(message: AgentMessage | undefined): unknown {
  if (!message || message.role !== "assistant") return undefined;
  return message.content.find((part) => part.type === "reasoning")?.providerMetadata;
}

function reasoningParts(message: AgentMessage | undefined): Array<{ text: string; providerMetadata?: unknown }> {
  if (!message || message.role !== "assistant") return [];
  return message.content.filter((part) => part.type === "reasoning");
}

main();
