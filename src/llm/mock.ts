/**
 * Mock 模型 provider。
 *
 * 这个 provider 不模拟复杂智能，只提供足够稳定的响应来跑通 CLI、工具、权限和 session 流程。
 * 编辑建议也只支持明确的“把 A 改成 B”表达，方便本地开发和自动化验证。
 */
import type { CommandAnalysisInput, FileEditInput, FileEditProposal, LLMProvider, ChatMessage, LLMRequest, LLMResponse } from "./provider.js";
import { detectIntent } from "../agent/intent.js";

export class MockProvider implements LLMProvider {
  async createResponse(request: LLMRequest): Promise<LLMResponse> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      return { content: `工具 ${last.name ?? last.toolCallId ?? ""} 返回：${last.content}` };
    }
    const userMessage = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const question = extractQuestion(userMessage);
    const intent = detectIntent(question);
    if (intent.type === "read_file" && intent.filePath) {
      return { content: "", toolCalls: [{ id: "mock-read-file", name: "read_file", args: { path: intent.filePath } }] };
    }
    if (intent.type === "search_files" && intent.query) {
      return { content: "", toolCalls: [{ id: "mock-search-files", name: "search_files", args: { query: intent.query, maxResults: 50 } }] };
    }
    if (intent.type === "git_diff") {
      return { content: "", toolCalls: [{ id: "mock-git-diff", name: "git_diff", args: {} }] };
    }
    if (intent.type === "run_command" && intent.command) {
      return { content: "", toolCalls: [{ id: "mock-run-command", name: "run_command", args: { command: intent.command } }] };
    }
    return { content: await this.chat(request.messages) };
  }

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
    // Mock 分析只截断输出做摘要，避免测试命令输出过长时刷满终端。
    if (input.exitCode === 0) return `命令执行成功：${input.command}\n${input.stdout.slice(0, 1000)}`;
    return `命令执行失败，退出码 ${input.exitCode}：${input.command}\nSTDERR:\n${input.stderr.slice(0, 1000)}`;
  }

  async proposeFileEdit(input: FileEditInput): Promise<FileEditProposal> {
    // mock 编辑器只支持明确的“把 A 改成 B”表达，保证替换行为可预测。
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
  // Agent 会把项目上下文和用户问题拼在一起；mock 只取最后的问题部分回显。
  const marker = "\n\nQuestion:\n";
  const index = content.lastIndexOf(marker);
  if (index !== -1) return content.slice(index + marker.length).trim().slice(0, 300);
  const taskMarker = "\n\nTask:\n";
  const taskIndex = content.lastIndexOf(taskMarker);
  if (taskIndex !== -1) return content.slice(taskIndex + taskMarker.length).trim().slice(0, 300);
  return content.trim().slice(0, 300);
}

function parseReplacement(instruction: string): { oldText: string; newText: string } | undefined {
  // 先匹配中文替换表达，再匹配英文 change/replace/update 表达。
  const chinese = instruction.match(/把\s+(.+?)\s*(?:改成|替换为)\s*(.+?)(?:$|。|，)/);
  if (chinese) return { oldText: chinese[1]?.trim() ?? "", newText: chinese[2]?.trim() ?? "" };

  const english = instruction.match(/(?:change|replace|update)\s+(.+?)\s+(?:to|with)\s+(.+?)$/i);
  if (english) return { oldText: english[1]?.trim() ?? "", newText: english[2]?.trim() ?? "" };

  return undefined;
}
