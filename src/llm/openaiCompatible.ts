import type { ChatMessage, CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider } from "./provider.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await this.complete(messages);
    return response;
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    return this.chat([
      { role: "system", content: "Analyze this local command result concisely." },
      { role: "user", content: JSON.stringify(input, null, 2) }
    ]);
  }

  async proposeFileEdit(input: FileEditInput): Promise<FileEditProposal> {
    const content = await this.chat([
      { role: "system", content: "Return JSON only with oldText, newText, explanation." },
      { role: "user", content: JSON.stringify(input) }
    ]);
    const parsed = JSON.parse(content) as unknown;
    if (!isEditProposal(parsed)) throw new Error("Provider did not return a valid edit proposal.");
    return parsed;
  }

  private async complete(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({ model: this.options.model, messages })
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

function isEditProposal(value: unknown): value is FileEditProposal {
  return typeof value === "object" && value !== null && "oldText" in value && "newText" in value && "explanation" in value;
}
