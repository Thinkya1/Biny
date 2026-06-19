import type { CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider, ChatMessage } from "./provider.js";

export class MockProvider implements LLMProvider {
  async chat(messages: ChatMessage[]): Promise<string> {
    // MockProvider 只用于验证 CLI、工具、权限和 session 流程；不要在这里模拟真实模型能力。
    const userMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const question = extractQuestion(userMessage);
    return [
      "模型未接入，当前使用 MockProvider。",
      question ? `收到输入：${question}` : "",
      "可用能力：读取文件、搜索文件、生成计划、在确认后修改文件或执行命令。"
    ].filter(Boolean).join("\n");
  }

  async analyzeCommandResult(input: CommandAnalysisInput): Promise<string> {
    if (input.exitCode === 0) return `命令执行成功：${input.command}\n${input.stdout.slice(0, 1000)}`;
    return `命令执行失败，退出码 ${input.exitCode}：${input.command}\nSTDERR:\n${input.stderr.slice(0, 1000)}`;
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

function extractQuestion(content: string): string {
  const marker = "\n\nQuestion:\n";
  const index = content.lastIndexOf(marker);
  if (index !== -1) return content.slice(index + marker.length).trim().slice(0, 300);
  const taskMarker = "\n\nTask:\n";
  const taskIndex = content.lastIndexOf(taskMarker);
  if (taskIndex !== -1) return content.slice(taskIndex + taskMarker.length).trim().slice(0, 300);
  return content.trim().slice(0, 300);
}

function parseReplacement(instruction: string): { oldText: string; newText: string } | undefined {
  const chinese = instruction.match(/把\s+(.+?)\s*(?:改成|替换为)\s*(.+?)(?:$|。|，)/);
  if (chinese) return { oldText: chinese[1]?.trim() ?? "", newText: chinese[2]?.trim() ?? "" };

  const english = instruction.match(/(?:change|replace|update)\s+(.+?)\s+(?:to|with)\s+(.+?)$/i);
  if (english) return { oldText: english[1]?.trim() ?? "", newText: english[2]?.trim() ?? "" };

  return undefined;
}
