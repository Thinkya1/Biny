import { formatProjectContext } from "../../project/ProjectContext.js";
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";

export async function planCommand(workspaceRoot: string, task: string): Promise<void> {
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    runtime.recorder.record({ type: "user_message", content: `plan: ${task}` });
    // 当前 plan 仍通过 MockProvider 产出备注，但不会执行任何写入、编辑或命令工具。
    const plan = await runtime.llm.chat([
      { role: "system", content: "Create a deterministic execution plan. Do not execute tools." },
      { role: "user", content: `${formatProjectContext(runtime.projectContext)}\n\nTask:\n${task}` }
    ]);
    const output = formatPlan(task, runtime.projectContext.srcTree.slice(0, 20), plan);
    runtime.recorder.record({ type: "assistant_message", content: output });
    console.log(output);
    console.log(`\nSession: ${runtime.recorder.filePath}`);
  });
}

function formatPlan(task: string, srcTree: string[], mockNotes: string): string {
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
    "- MockProvider can only produce conservative plans.",
    "- Plan mode does not execute writes, edits, or commands, so feasibility is not verified.",
    "- Larger changes may require inspecting more specific files.",
    "",
    "MockProvider Notes",
    mockNotes
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
