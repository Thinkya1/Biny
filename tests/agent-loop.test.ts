import assert from "node:assert/strict";
import { tool, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import { z } from "zod";
import { runAgentLoop } from "../src/agent/agentLoop.js";

type ScriptedStep = { kind: "tool-call"; toolCallId: string } | { kind: "stop"; text: string } | { kind: "length"; text: string };

async function main(): Promise<void> {
  await testContinuesWhileToolCallsRemain();
  await testStopsAtMaxSteps();
  await testTruncatedOutputStopsTheLoop();
  await testTransformContextRunsPerStepAndCarriesForward();
  await testSingleStartAndFinishPerRun();
  console.log("agent loop tests passed");
}

/** tool-calls 续跑、stop 收尾：一次运行 = 两次 provider 请求。 */
async function testContinuesWhileToolCallsRemain(): Promise<void> {
  const model = scriptedModel([
    { kind: "tool-call", toolCallId: "call-1" },
    { kind: "stop", text: "done" }
  ]);
  const result = await runAgentLoop([userMessage("go")], {
    model: model.model,
    tools: pingTools(),
    maxSteps: 8,
    onPart: () => undefined
  });
  assert.equal(model.calls.length, 2);
  assert.equal(result.steps.length, 2);
  assert.equal(result.text, "done");
  assert.equal(result.stopReason, "model_stop");
  // 第二次请求必须带上第一步的 assistant + tool 消息，否则模型看不到工具结果。
  assert.equal(model.calls[1]?.some((message) => message.role === "tool"), true);
}

/** maxSteps 是循环自己的边界，不再依赖 SDK 的 stopWhen。 */
async function testStopsAtMaxSteps(): Promise<void> {
  const model = scriptedModel([{ kind: "tool-call", toolCallId: "loop" }], { repeatLast: true });
  const result = await runAgentLoop([userMessage("go")], {
    model: model.model,
    tools: pingTools(),
    maxSteps: 3,
    onPart: () => undefined
  });
  assert.equal(model.calls.length, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.stopReason, "step_limit");
}

/**
 * 输出被 token 上限截断后不能再发一次请求 —— 那等于让模型在半句话上继续推理。
 * SDK 的 stopWhen 只看「最后一步有没有 tool result」，不看这个。
 */
async function testTruncatedOutputStopsTheLoop(): Promise<void> {
  const model = scriptedModel([
    { kind: "length", text: "half a th" },
    { kind: "stop", text: "should never run" }
  ]);
  const result = await runAgentLoop([userMessage("go")], {
    model: model.model,
    tools: pingTools(),
    maxSteps: 8,
    onPart: () => undefined
  });
  assert.equal(model.calls.length, 1, "a truncated step must not trigger another provider request");
  assert.equal(result.stopReason, "output_truncated");
  assert.equal(result.finishReason, "length");
}

/** 回合内上下文治理的接缝：每步都跑，且改写结果带入后续步骤。 */
async function testTransformContextRunsPerStepAndCarriesForward(): Promise<void> {
  const model = scriptedModel([
    { kind: "tool-call", toolCallId: "call-1" },
    { kind: "stop", text: "done" }
  ]);
  const seenStepIndexes: number[] = [];
  await runAgentLoop([userMessage("go")], {
    model: model.model,
    tools: pingTools(),
    maxSteps: 8,
    transformContext: async (messages, info) => {
      seenStepIndexes.push(info.index);
      return [userMessage(`rewritten-${String(info.index)}`), ...messages.slice(1)];
    },
    onPart: () => undefined
  });
  assert.deepEqual(seenStepIndexes, [0, 1]);
  assert.equal(messageText(model.calls[0]?.[0]), "rewritten-0");
  // 第 1 步看到的首条消息是第 0 步改写后的版本再被改写一次，证明改写结果确实带入了后续步骤。
  assert.equal(messageText(model.calls[1]?.[0]), "rewritten-1");
}

/** 每步各有一对 start/finish，但对外只应暴露一次运行。 */
async function testSingleStartAndFinishPerRun(): Promise<void> {
  const model = scriptedModel([
    { kind: "tool-call", toolCallId: "call-1" },
    { kind: "stop", text: "done" }
  ]);
  const parts: Array<TextStreamPart<ToolSet>> = [];
  await runAgentLoop([userMessage("go")], {
    model: model.model,
    tools: pingTools(),
    maxSteps: 8,
    onPart: (part) => parts.push(part)
  });
  assert.equal(parts.filter((part) => part.type === "start").length, 1);
  assert.equal(parts.filter((part) => part.type === "finish").length, 1);
  // 每个 provider step 仍然各自可见，消费者据此划分步边界。
  assert.equal(parts.filter((part) => part.type === "start-step").length, 2);
  assert.equal(parts[parts.length - 1]?.type, "finish");
}

function pingTools(): ToolSet {
  return {
    ping: tool({
      description: "Test tool.",
      inputSchema: z.object({}),
      execute: async () => "pong"
    })
  } as ToolSet;
}

function userMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

function messageText(message: ModelMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function scriptedModel(
  script: ScriptedStep[],
  options: { repeatLast?: boolean } = {}
): { model: LanguageModel; calls: ModelMessage[][] } {
  const calls: ModelMessage[][] = [];
  const model = {
    specificationVersion: "v3",
    provider: "loop-test",
    modelId: "loop-test",
    supportedUrls: {},
    doStream: async ({ prompt }: { prompt: unknown }) => {
      const index = calls.length;
      calls.push(promptToMessages(prompt));
      const step = script[index] ?? (options.repeatLast ? script[script.length - 1] : undefined);
      if (!step) throw new Error(`Scripted model ran out of steps at index ${String(index)}.`);
      return { stream: stepStream(step) };
    }
  } as unknown as LanguageModel;
  return { model, calls };
}

function stepStream(step: ScriptedStep): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step.kind === "tool-call") {
        controller.enqueue({ type: "tool-input-start", id: step.toolCallId, toolName: "ping" });
        controller.enqueue({ type: "tool-input-delta", id: step.toolCallId, delta: "{}" });
        controller.enqueue({ type: "tool-input-end", id: step.toolCallId });
        controller.enqueue({ type: "tool-call", toolCallId: step.toolCallId, toolName: "ping", input: "{}" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: 1, outputTokens: 1 }
        });
        controller.close();
        return;
      }
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({ type: "text-delta", id: "text-1", delta: step.text });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        finishReason: step.kind === "length" ? { unified: "length", raw: "length" } : { unified: "stop", raw: "stop" },
        usage: { inputTokens: 1, outputTokens: 1 }
      });
      controller.close();
    }
  });
}

function promptToMessages(prompt: unknown): ModelMessage[] {
  if (!Array.isArray(prompt)) return [];
  return prompt as ModelMessage[];
}

await main();
