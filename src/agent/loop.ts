import { promises as fs } from "node:fs";
import { confirmAction } from "../permission/confirm.js";
import { commandSafetyWarnings, requiresConfirmation, type ToolName } from "../permission/policy.js";
import { formatProjectContext } from "../project/ProjectContext.js";
import type { EditFileArgs, EditFileResult } from "../tools/file/editFile.js";
import type { ReadFileArgs, ReadFileResult } from "../tools/file/readFile.js";
import type { WriteFileArgs, WriteFileResult } from "../tools/file/writeFile.js";
import type { SearchFilesArgs, SearchFilesResult } from "../tools/search/searchFiles.js";
import type { RunCommandArgs, RunCommandResult } from "../tools/shell/runCommand.js";
import { createUnifiedDiff } from "../utils/diff.js";
import { resolveWorkspacePath } from "../workspace/resolvePath.js";
import { detectIntent } from "./intent.js";
import type { AgentRuntimeContext } from "./types.js";

export async function runAgentTask(input: string, context: AgentRuntimeContext): Promise<string> {
  const registry = context.toolRegistry;
  context.recorder.record({ type: "user_message", content: input });

  try {
    // 当前还没有真实模型和 function calling，所以先用轻量 intent 识别把自然语言路由到本地工具。
    // 后续接入真实模型时，这里应该替换为“模型返回 tool_call，AgentLoop 统一执行工具”的流程。
    const intent = detectIntent(input);

    if (intent.type === "read_file") {
      if (!intent.filePath) throw new Error("No file path found in request.");
      const result = await callTool<ReadFileArgs, ReadFileResult>("read_file", { path: intent.filePath });
      const answer = await context.llm.chat([
        { role: "system", content: "Explain this file concisely." },
        { role: "user", content: `${result.path}\n\n${result.content}` }
      ]);
      return recordAssistantMessage(answer);
    }

    if (intent.type === "write_file") {
      if (!intent.filePath) throw new Error("No file path found in write request.");
      const content = intent.content ?? "";
      const args = { path: intent.filePath, content };
      const oldContent = await readExistingFileForDiff(intent.filePath);
      const diff = createUnifiedDiff(intent.filePath, oldContent, content);
      // 写文件属于有副作用操作，先展示 diff，并把确认结果写入 session。
      const allowed = await confirmTool("write_file", "File write request", `File: ${args.path}\nBytes: ${Buffer.byteLength(content, "utf8")}\n\nDiff:\n${diff}`, false, diff);
      if (!allowed) return recordAssistantMessage("Write cancelled.");

      const result = await callTool<WriteFileArgs, WriteFileResult>("write_file", args);
      return recordAssistantMessage(`Wrote ${result.path} (${result.bytes} bytes).`);
    }

    if (intent.type === "edit_file") {
      if (!intent.filePath) throw new Error("No file path found in edit request.");
      const file = await callTool<ReadFileArgs, ReadFileResult>("read_file", { path: intent.filePath });

      const proposal = await context.llm.proposeFileEdit({ instruction: input, path: intent.filePath, content: file.content });
      const nextContent = file.content.replace(proposal.oldText, proposal.newText);
      const diff = createUnifiedDiff(intent.filePath, file.content, nextContent);
      const plan = `File: ${intent.filePath}\nOld text: ${proposal.oldText}\nNew text: ${proposal.newText}\nReason: ${proposal.explanation}\n\nDiff:\n${diff}`;
      // edit_file 也必须先确认，真正写入只发生在用户允许之后。
      const allowed = await confirmTool("edit_file", "Proposed file edit", plan, false, diff);
      if (!allowed) return recordAssistantMessage("Edit cancelled.");

      const edit = await callTool<EditFileArgs, EditFileResult>("edit_file", {
        path: intent.filePath,
        oldText: proposal.oldText,
        newText: proposal.newText
      });
      return recordAssistantMessage(`Edited ${edit.path} (${edit.replacements} replacement).`);
    }

    if (intent.type === "search_files") {
      if (!intent.query) throw new Error("No search query found in request.");
      const result = await callTool<SearchFilesArgs, SearchFilesResult>("search_files", { query: intent.query, maxResults: 50 });
      const lines = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
      return recordAssistantMessage(lines.length ? lines.join("\n") : `No matches for: ${intent.query}`);
    }

    if (intent.type === "run_command") {
      if (!intent.command) throw new Error("No command found in request.");
      const warnings = commandSafetyWarnings(intent.command);
      const details = [intent.command, warnings.length ? `\nSensitive command warning: ${warnings.join(", ")}` : ""].join("");
      const allowed = await confirmTool("run_command", "Command execution request", details, warnings.length > 0);
      if (!allowed) return recordAssistantMessage("Command cancelled.");

      const result = await callTool<RunCommandArgs, RunCommandResult>("run_command", { command: intent.command });
      const analysis = await context.llm.analyzeCommandResult({ command: intent.command, ...result });
      return recordAssistantMessage(analysis);
    }

    const answer = await context.llm.chat([
      { role: "system", content: "Answer questions about this local project using the provided context." },
      { role: "user", content: `${formatProjectContext(context.projectContext)}\n\nQuestion:\n${input}` }
    ]);
    return recordAssistantMessage(answer);
  } catch (error) {
    context.recorder.record({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  async function callTool<TArgs, TResult>(name: ToolName, args: TArgs): Promise<TResult> {
    // 工具执行统一经过这里，保证所有 tool_call / tool_result 都能进入 jsonl session。
    context.recorder.record({ type: "tool_call", tool: name, args });
    try {
      const result = await registry.get<TArgs, TResult>(name).execute(args);
      context.recorder.record({ type: "tool_result", tool: name, result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.recorder.record({ type: "tool_result", tool: name, result: { error: message } });
      throw error;
    }
  }

  async function confirmTool(name: ToolName, title: string, details: string, requireFullYes = false, diff?: string): Promise<boolean> {
    if (!requiresConfirmation(name)) return true;
    // 权限请求暂时复用 tool_call/tool_result 事件；以后可以替换成 PermissionService，
    // 但 session 的基础事件类型不需要变化。
    context.recorder.record({ type: "tool_call", tool: name, args: { confirmation: true, details } });
    const allowed = await confirmAction(title, details, { requireFullYes });
    context.recorder.record({ type: "tool_result", tool: name, result: { status: allowed ? "approved" : "cancelled", approved: allowed, diff } });
    return allowed;
  }

  function recordAssistantMessage(content: string): string {
    context.recorder.record({ type: "assistant_message", content });
    return content;
  }

  async function readExistingFileForDiff(filePath: string): Promise<string> {
    const absolutePath = resolveWorkspacePath(context.workspaceRoot, filePath, context.config.workspace.ignore);
    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }
}
