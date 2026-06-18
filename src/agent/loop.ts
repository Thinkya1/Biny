import { confirmAction } from "../permission/confirm.js";
import { createTools } from "../tools/registry.js";
import { buildProjectContext } from "./context.js";
import { detectIntent } from "./intent.js";
import type { AgentRuntimeContext } from "./types.js";

export async function runAgentTask(input: string, context: AgentRuntimeContext): Promise<string> {
  const tools = createTools({ workspaceRoot: context.workspaceRoot, ignore: context.config.workspace.ignore });
  context.recorder.record({ type: "user_input", content: input });

  const intent = detectIntent(input);
  context.recorder.record({ type: "intent", intent: intent.type, filePath: intent.filePath, command: intent.command });

  if (intent.type === "read_file") {
    if (!intent.filePath) throw new Error("No file path found in request.");
    context.recorder.record({ type: "tool_call", tool: "read_file", args: { path: intent.filePath } });
    const result = await tools.readFile.execute({ path: intent.filePath });
    context.recorder.record({ type: "tool_result", tool: "read_file", result: { path: result.path, bytes: result.content.length } });
    const answer = await context.llm.chat([
      { role: "system", content: "Explain this file concisely." },
      { role: "user", content: `${result.path}\n\n${result.content}` }
    ]);
    context.recorder.record({ type: "final", content: answer });
    return answer;
  }

  if (intent.type === "edit_file") {
    if (!intent.filePath) throw new Error("No file path found in edit request.");
    context.recorder.record({ type: "tool_call", tool: "read_file", args: { path: intent.filePath } });
    const file = await tools.readFile.execute({ path: intent.filePath });
    context.recorder.record({ type: "tool_result", tool: "read_file", result: { path: file.path, bytes: file.content.length } });

    const proposal = await context.llm.proposeFileEdit({ instruction: input, path: intent.filePath, content: file.content });
    const plan = `File: ${intent.filePath}\nOld text: ${proposal.oldText}\nNew text: ${proposal.newText}\nReason: ${proposal.explanation}`;
    context.recorder.record({ type: "permission_request", tool: "edit_file", args: proposal });
    const allowed = await confirmAction("Proposed file edit", plan);
    if (!allowed) {
      context.recorder.record({ type: "permission_denied", tool: "edit_file" });
      const message = "Edit cancelled.";
      context.recorder.record({ type: "final", content: message });
      return message;
    }

    context.recorder.record({ type: "permission_granted", tool: "edit_file" });
    const edit = await tools.editFile.execute({ path: intent.filePath, oldText: proposal.oldText, newText: proposal.newText });
    context.recorder.record({ type: "tool_result", tool: "edit_file", result: edit });
    const diff = await tools.gitDiff.execute({});
    const output = `Edited ${edit.path} (${edit.replacements} replacement).\n\nGit diff:\n${diff.output || "(no diff)"}`;
    context.recorder.record({ type: "tool_call", tool: "git_diff", args: {} });
    context.recorder.record({ type: "tool_result", tool: "git_diff", result: diff });
    context.recorder.record({ type: "final", content: output });
    return output;
  }

  if (intent.type === "run_command") {
    if (!intent.command) throw new Error("No command found in request.");
    context.recorder.record({ type: "permission_request", tool: "run_command", args: { command: intent.command } });
    const allowed = await confirmAction("Command execution request", intent.command);
    if (!allowed) {
      context.recorder.record({ type: "permission_denied", tool: "run_command" });
      const message = "Command cancelled.";
      context.recorder.record({ type: "final", content: message });
      return message;
    }

    context.recorder.record({ type: "permission_granted", tool: "run_command" });
    context.recorder.record({ type: "tool_call", tool: "run_command", args: { command: intent.command } });
    const result = await tools.runCommand.execute({ command: intent.command });
    context.recorder.record({ type: "tool_result", tool: "run_command", result });
    const analysis = await context.llm.analyzeCommandResult({ command: intent.command, ...result });
    context.recorder.record({ type: "final", content: analysis });
    return analysis;
  }

  const projectContext = await buildProjectContext(context.workspaceRoot, context.config.workspace.ignore);
  context.recorder.record({ type: "tool_call", tool: "list_files", args: { limit: 80 } });
  const answer = await context.llm.chat([
    { role: "system", content: "Answer questions about this local project using the provided context." },
    { role: "user", content: `${projectContext}\n\nQuestion:\n${input}` }
  ]);
  context.recorder.record({ type: "final", content: answer });
  return answer;
}
