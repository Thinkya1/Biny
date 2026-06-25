/**
 * 计划命令模块。
 *
 * `plan` 模式把项目摘要和任务交给模型，让它生成执行计划，但不会调用写入、编辑或命令工具。
 * 输出保持固定章节结构，方便用户在真正执行前先审阅范围、步骤和风险。
 */
import { buildSystemPrompt } from "../../agent/prompts.js";
import { formatProjectContext } from "../../project/ProjectContext.js";
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";

export async function planCommand(workspaceRoot: string, task: string): Promise<void> {
  // plan 命令只生成计划并记录 session，不执行写入、编辑或命令工具。
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    runtime.recorder.record({ type: "user_message", content: `plan: ${task}` });
    const plan = await runtime.llm.chat([
      { role: "system", content: buildSystemPrompt("plan") },
      { role: "user", content: `${formatProjectContext(runtime.projectContext)}\n\nTask:\n${task}` }
    ]);
    const output = formatPlan(task, runtime.projectContext.srcTree.slice(0, 20), plan);
    runtime.recorder.record({ type: "assistant_message", content: output });
    console.log(output);
    console.log(`\nSession: ${runtime.recorder.filePath}`);
  });
}

function formatPlan(task: string, srcTree: string[], providerNotes: string): string {
  // 固定结构方便用户快速扫读，也方便未来把 plan 输出解析成 TUI 计划视图。
  return [
    "Goal",
    `- ${task}`,
    "",
    "Files To Inspect",
    ...candidateFiles(srcTree).map((file) => `- ${file}`),
    "",
    "Possible Tools",
    "- list_files",
    "- read_file",
    "- search_files",
    "- write_file / edit_file (not executed in plan mode)",
    "- run_command (not executed in plan mode)",
    "",
    "Steps",
    "- Collect ProjectContext to understand structure, scripts, and git status.",
    "- Use list_files or search_files to locate relevant files.",
    "- Use read_file to inspect limited file content.",
    "- Draft the change approach and show a diff before execution.",
    "- If validation is needed, ask for confirmation before running commands.",
    "",
    "Risks",
    "- Provider output should be reviewed before executing changes.",
    "- Plan mode does not execute writes, edits, or commands, so feasibility is not verified.",
    "- Larger changes may require inspecting more specific files.",
    "",
    "Provider Notes",
    providerNotes
  ].join("\n");
}

function candidateFiles(srcTree: string[]): string[] {
  // 计划阶段只给出候选文件，不读取全部源码；真正执行时再按需 read_file。
  const files = srcTree
    .map((entry) => entry.replace(/^\s*\[f\]\s+/, "").trim())
    .filter((entry) => entry.startsWith("src/"))
    .slice(0, 8);
  return files.length ? files : ["package.json", "README.md", "tsconfig.json"];
}
