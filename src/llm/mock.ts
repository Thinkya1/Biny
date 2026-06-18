import type { CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider, ChatMessage } from "./provider.js";

export class MockProvider implements LLMProvider {
  async chat(messages: ChatMessage[]): Promise<string> {
    const last = messages.at(-1)?.content ?? "";
    return [
      "MockProvider answer:",
      "I can inspect local files, propose simple edits, and run approved commands.",
      last ? `Input summary: ${last.slice(0, 500)}` : ""
    ].filter(Boolean).join("\n");
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    if (input.exitCode === 0) return `Command succeeded: ${input.command}\n${input.stdout.slice(0, 1000)}`;
    return `Command failed with exit code ${input.exitCode}: ${input.command}\nSTDERR:\n${input.stderr.slice(0, 1000)}`;
  }

  async proposeFileEdit(input: FileEditInput): Promise<FileEditProposal> {
    const replacement = parseReplacement(input.instruction);
    if (!replacement) {
      throw new Error("MockProvider can only propose edits like: 把 hello 改成 hello agent / change hello to hello agent");
    }
    if (!input.content.includes(replacement.oldText)) {
      throw new Error(`Cannot propose edit: old text not found in ${input.path}: ${replacement.oldText}`);
    }
    return {
      oldText: replacement.oldText,
      newText: replacement.newText,
      explanation: `Replace "${replacement.oldText}" with "${replacement.newText}" in ${input.path}.`
    };
  }
}

function parseReplacement(instruction: string): { oldText: string; newText: string } | undefined {
  const chinese = instruction.match(/把\s+(.+?)\s*(?:改成|替换为)\s*(.+?)(?:$|。|，)/);
  if (chinese) return { oldText: chinese[1]?.trim() ?? "", newText: chinese[2]?.trim() ?? "" };

  const english = instruction.match(/(?:change|replace|update)\s+(.+?)\s+(?:to|with)\s+(.+?)$/i);
  if (english) return { oldText: english[1]?.trim() ?? "", newText: english[2]?.trim() ?? "" };

  return undefined;
}
