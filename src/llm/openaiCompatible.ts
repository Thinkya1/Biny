import { buildSystemPrompt } from "../agent/prompts.js";
import type { ChatMessage, CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider } from "./provider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await this.complete(messages);
    return response;
  }

  async streamChat(messages: ChatMessage[], onDelta: (delta: string) => void, options?: { signal?: AbortSignal }): Promise<string> {
    return await this.completeStream(messages, onDelta, options?.signal);
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    return this.chat([
      { role: "system", content: buildSystemPrompt("analyzeCommand") },
      { role: "user", content: JSON.stringify(input, null, 2) }
    ]);
  }

  async proposeFileEdit(input: FileEditInput): Promise<FileEditProposal> {
    const content = await this.chat([
      { role: "system", content: buildSystemPrompt("editFile") },
      { role: "user", content: JSON.stringify(input) }
    ]);
    const parsed = JSON.parse(extractJsonObject(content)) as unknown;
    if (!isEditProposal(parsed)) throw new Error("Provider did not return a valid edit proposal.");
    return parsed;
  }

  private async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({ model: this.options.model, messages, stream: false })
    }).finally(() => {
      clearTimeout(timeout);
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  private async completeStream(messages: ChatMessage[], onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.options.model, messages, stream: true })
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
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") return undefined;
  const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
  return parsed.choices?.[0]?.delta?.content;
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function isEditProposal(value: unknown): value is FileEditProposal {
  return typeof value === "object" && value !== null && "oldText" in value && "newText" in value && "explanation" in value;
}
