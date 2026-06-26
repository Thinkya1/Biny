/**
 * OpenAI 兼容模型 provider。
 *
 * 这里封装 `/chat/completions` 的非流式和 SSE 流式请求，并把命令分析、文件编辑建议转换成
 * 普通 chat 调用。编辑建议要求模型返回 JSON，写文件前还会再次校验结构和命中文本。
 */
import { buildSystemPrompt } from "../agent/prompts.js";
import type { ChatMessage, CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider, LLMRequest, LLMResponse } from "./provider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async createResponse(request: LLMRequest): Promise<LLMResponse> {
    return await this.completeResponse(request);
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    // 非流式 chat 用于普通 CLI 命令，直接返回最终 assistant 文本。
    const response = await this.complete(messages);
    return response;
  }

  async streamChat(messages: ChatMessage[], onDelta: (delta: string) => void, options?: { signal?: AbortSignal }): Promise<string> {
    // TUI 传入 onDelta 后可以边生成边渲染，同时仍返回完整内容给 session 记录。
    return await this.completeStream(messages, onDelta, options?.signal);
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    return this.chat([
      { role: "system", content: buildSystemPrompt("analyzeCommand") },
      { role: "user", content: JSON.stringify(input, null, 2) }
    ]);
  }

  async proposeFileEdit(input: FileEditInput): Promise<FileEditProposal> {
    // 编辑建议要求模型返回 JSON；解析和类型检查都在写文件前完成。
    const content = await this.chat([
      { role: "system", content: buildSystemPrompt("editFile") },
      { role: "user", content: JSON.stringify(input) }
    ]);
    const parsed = JSON.parse(extractJsonObject(content)) as unknown;
    if (!isEditProposal(parsed)) throw new Error("Provider did not return a valid edit proposal.");
    return parsed;
  }

  private async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    // provider 级超时保护外部 API 调用，避免命令长期挂起。
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({ model: this.options.model, messages: toApiMessages(messages), stream: false })
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    // 兼容空 choices 的响应，交给上层按空字符串处理。
    return json.choices?.[0]?.message?.content ?? "";
  }

  private async completeResponse(request: LLMRequest): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: toApiMessages(request.messages),
        ...(tools.length ? { tools } : {}),
        stream: false
      })
    }).finally(() => {
      request.signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const message = json.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: message?.tool_calls?.map((call) => ({
        id: call.id ?? "",
        name: call.function?.name ?? "",
        args: parseToolArguments(call.function?.arguments ?? "{}")
      })).filter((call) => call.name)
    };
  }

  private async completeStream(messages: ChatMessage[], onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const abort = () => controller.abort();
    // 外部 abortSignal 来自当前 turn，中断后会取消底层 fetch。
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.options.model, messages: toApiMessages(messages), stream: true })
      });
      if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
      if (!response.body) throw new Error("OpenAI-compatible streaming response has no body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // SSE 可能跨 chunk 截断一行，所以保留最后一个未完成行到下一轮。
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const delta = parseSseDelta(line);
          if (!delta) continue;
          content += delta;
          onDelta(delta);
        }
      }
      return content;
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    }
  }
}

function parseSseDelta(line: string): string | undefined {
  // 只消费 data 行；空行、注释行和 [DONE] 都不产生内容增量。
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") return undefined;
  const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
  return parsed.choices?.[0]?.delta?.content;
}

function extractJsonObject(content: string): string {
  // 兼容模型返回裸 JSON 或 Markdown fenced code block 两种格式。
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function isEditProposal(value: unknown): value is FileEditProposal {
  // 这里只做结构最小校验；oldText 是否命中文件由 edit_file 工具再次确认。
  return typeof value === "object" && value !== null && "oldText" in value && "newText" in value && "explanation" in value;
}

function toApiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: stringifyToolArguments(toolCall.args)
          }
        }))
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? message.name ?? "tool",
        content: message.content
      };
    }
    return { role: message.role, content: message.content };
  });
}

function stringifyToolArguments(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
