/**
 * Biny 自有的 agent loop。
 *
 * AI SDK 仍然负责单次 provider 请求 —— transport、流式归一、工具调用解析和执行都还在它
 * 手里。变化的是**续跑判定归这里**：`streamText` 不传 `stopWhen` 时只走一个 provider
 * step（SDK 默认 `isStepCount(1)`），多步由本模块的循环驱动。
 *
 * 这样每一步之间就有了一个我们自己的接缝，可以改写 context、检查预算、按步落盘 —— 这些
 * 在 `ToolLoopAgent` 内部是够不到的。
 *
 * 设计参考 pi 的 `agent-loop.ts`：context 变换、停止判定和续跑策略都由调用方通过 hook
 * 提供，loop 本身不持有策略。
 */
import { streamText, type FinishReason, type LanguageModel, type LanguageModelUsage, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";

/** 一个 provider step 的结果。 */
export interface AgentLoopStep {
  index: number;
  text: string;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  responseMessages: ModelMessage[];
  /** 从 assistant 消息正文解析出的合法工具调用；续跑只认这里，不信 finishReason。 */
  toolCalls: AgentLoopToolCall[];
  /** 这一步结束时的完整 context，供调用方按步落盘。 */
  messages: ModelMessage[];
}

export interface AgentLoopToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface AgentLoopStepInfo {
  /** 即将执行的步序号，从 0 开始。 */
  index: number;
  /** 已完成的步。 */
  completed: readonly AgentLoopStep[];
}

/** 循环停下来的原因，供调用方区分「模型说完了」和「我们不让它继续」。 */
export type AgentLoopStopReason =
  | "model_stop"
  | "step_limit"
  | "output_truncated"
  | "coordinator_checkpoint";

export interface AgentLoopConfig {
  model: LanguageModel;
  tools: ToolSet;
  maxSteps: number;
  /** 透传给 streamText 的调用参数（maxRetries / providerOptions / reasoning / timeout 等）。 */
  streamOptions?: Record<string, unknown>;

  /**
   * 每次 provider 请求前改写 context，返回的 messages 会带入后续步骤。
   *
   * 这是回合内上下文治理的落点：`ToolLoopAgent` 把整个多步循环包在一次调用里，回合中途
   * 没有任何机会介入，长回合只能眼看着工具结果把窗口撑爆。
   *
   * 约定：不得抛异常。失败时返回原 messages，否则会打断循环且不产生正常事件序列。
   */
  transformContext?: (messages: ModelMessage[], info: AgentLoopStepInfo) => Promise<ModelMessage[]>;

  /** 每个 provider step 开始前触发。 */
  onStepStart?: (info: AgentLoopStepInfo) => void;
  /** 每个 provider step 结束后触发，可用于按步落盘。约定同样不得抛异常。 */
  onStepEnd?: (step: AgentLoopStep) => Promise<void> | void;
  /**
   * 实际工具调用完成并回填结果后，允许上层在下一次 provider 请求前接管。
   *
   * 这只形成低层 checkpoint，不代表任务完成。典型用途是让 Coordinator 检查工具调用量、
   * 重复动作等结构化预算。
   */
  continueAfterToolCalls?: (step: AgentLoopStep) => boolean;
  /** Provider/SDK 标记为 schema-invalid 的调用由上层拒绝，不得作为合法续跑依据。 */
  isToolCallValid?: (call: AgentLoopToolCall) => boolean;
  /** 流式分片出口。 */
  onPart: (part: TextStreamPart<ToolSet>) => void;
}

export interface AgentLoopResult {
  kind:
    | "model_yielded"
    | "coordinator_checkpoint"
    | "budget_exhausted"
    | "output_truncated"
    | "cancelled"
    | "fatal_error";
  /** 循环结束时的完整 context。 */
  messages: ModelMessage[];
  /** 本次运行新产生的 assistant/tool 消息。 */
  responseMessages: ModelMessage[];
  steps: AgentLoopStep[];
  /** 最后一步的文本输出。 */
  text: string;
  /** 最后一步的 finishReason。 */
  finishReason: FinishReason;
  /** Provider 对最后一次响应给出的诊断值，不参与完成判断。 */
  providerFinishReason: FinishReason;
  stopReason: AgentLoopStopReason;
  assistantMessage?: ModelMessage;
  budget: { stepsUsed: number; stepLimit: number };
  error?: Error;
}

export async function runAgentLoop(
  initialMessages: readonly ModelMessage[],
  config: AgentLoopConfig,
  signal?: AbortSignal
): Promise<AgentLoopResult> {
  if (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1) {
    throw new RangeError("Agent loop maxSteps must be a positive safe integer.");
  }

  let messages = [...initialMessages];
  const responseMessages: ModelMessage[] = [];
  const steps: AgentLoopStep[] = [];
  let finishReason: FinishReason = "stop";
  let stopReason: AgentLoopStopReason = "model_stop";
  let kind: AgentLoopResult["kind"] = "model_yielded";
  let loopError: Error | undefined;
  // 一次运行对外只暴露一个 start/finish；每步的 streamText 各自有一对，逐个转发会让
  // 消费者以为发生了多次运行。
  let startForwarded = false;
  let deferredFinish: TextStreamPart<ToolSet> | undefined;

  try {
    for (let index = 0; index < config.maxSteps; index += 1) {
      signal?.throwIfAborted();
      const info: AgentLoopStepInfo = { index, completed: steps };
      if (config.transformContext) messages = await config.transformContext(messages, info);
      config.onStepStart?.(info);

      const result = streamText({
        ...config.streamOptions,
        model: config.model,
        messages,
        tools: config.tools,
        allowSystemInMessages: true,
        abortSignal: signal,
        // 不传 stopWhen：SDK 默认 isStepCount(1)，一次调用就是一个 provider step。
        // 续跑判定在下面由本循环做。
        onError: () => undefined
      });

      for await (const part of result.fullStream) {
        if (part.type === "start") {
          if (startForwarded) continue;
          startForwarded = true;
        }
        if (part.type === "finish") {
          deferredFinish = part as TextStreamPart<ToolSet>;
          continue;
        }
        config.onPart(part as TextStreamPart<ToolSet>);
      }

      const [stepFinishReason, stepResponseMessages, stepUsage, stepText] = await Promise.all([
        result.finishReason,
        result.responseMessages,
        result.usage,
        result.text
      ]);
      const parsedToolCalls = extractToolCalls(stepResponseMessages);
      const toolCalls = config.isToolCallValid
        ? parsedToolCalls.filter(config.isToolCallValid)
        : parsedToolCalls;
      responseMessages.push(...stepResponseMessages);
      messages = [...messages, ...stepResponseMessages];
      const step: AgentLoopStep = {
        index,
        text: stepText,
        finishReason: stepFinishReason,
        usage: stepUsage,
        responseMessages: stepResponseMessages,
        toolCalls,
        messages: [...messages]
      };
      steps.push(step);
      finishReason = stepFinishReason;
      await config.onStepEnd?.(step);

      if (stepFinishReason === "length") {
        // 输出被 token 上限截断后，即使里面碰巧带了工具调用，也不能在残缺上下文上继续推理。
        stopReason = "output_truncated";
        kind = "output_truncated";
        break;
      }
      if (toolCalls.length === 0) {
        // Provider 的 finishReason 只用于诊断。没有实际工具调用才代表模型把控制权交回上层。
        stopReason = "model_stop";
        kind = "model_yielded";
        break;
      }
      if (config.continueAfterToolCalls?.(step) === false) {
        stopReason = "coordinator_checkpoint";
        kind = "coordinator_checkpoint";
        break;
      }
      stopReason = "step_limit";
      kind = "budget_exhausted";
    }
  } catch (error) {
    loopError = error instanceof Error ? error : new Error(String(error));
    kind = signal?.aborted ? "cancelled" : "fatal_error";
  }

  if (deferredFinish) config.onPart(deferredFinish);
  return {
    kind,
    messages,
    responseMessages,
    steps,
    text: steps[steps.length - 1]?.text ?? "",
    finishReason,
    providerFinishReason: finishReason,
    stopReason,
    assistantMessage: [...responseMessages].reverse().find((message) => message.role === "assistant"),
    budget: { stepsUsed: steps.length, stepLimit: config.maxSteps },
    error: loopError
  };
}

/** 只接受消息正文里的完整工具调用；finishReason 不参与解析，也不能凭空制造调用。 */
export function extractToolCalls(messages: readonly ModelMessage[]): AgentLoopToolCall[] {
  const calls: AgentLoopToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part.type !== "tool-call"
        || typeof part.toolCallId !== "string"
        || !part.toolCallId
        || typeof part.toolName !== "string"
        || !part.toolName
      ) continue;
      calls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
    }
  }
  return calls;
}
