/**
 * TUI 计划数据模块。
 *
 * 这里可以根据当前 runtime 的项目上下文生成结构化计划，并把计划转换成文本格式。
 * 当前 plan 模式不执行工具，计划内容只是供用户审阅后再决定是否进入执行。
 */
import type { TuiRuntime } from "./runtime/createTuiRuntime.js";

export interface TuiPlan {
  task: string;
  goal: string;
  filesToInspect: string[];
  possibleTools: string[];
  steps: string[];
  risks: string[];
}

export function createStructuredPlan(runtime: TuiRuntime, task: string): TuiPlan {
  // 结构化计划直接来自当前 ProjectContext，不执行工具也不读取额外文件。
  const context = runtime.commandRuntime.projectContext;
  const files = candidateFiles(context.srcTree);
  return {
    task,
    goal: task,
    filesToInspect: files,
    possibleTools: [
      "list_files",
      "read_file",
      "search_files",
      "write_file / edit_file (only after confirmation)",
      "run_command (only after confirmation)"
    ],
    steps: [
      "Read the smallest set of relevant files.",
      "Identify the exact code paths and expected behavior.",
      "Make a focused change with the existing project style.",
      "Show a diff before file writes or edits.",
      "Run validation commands only after confirmation."
    ],
    risks: [
      "Plan mode does not execute tools or modify files.",
      "The plan may need revision after inspecting specific files.",
      "Commands and writes still require explicit approval in execution."
    ]
  };
}

export function formatStructuredPlan(plan: TuiPlan): string {
  // 文本格式用于 session 记录或降级展示，保留和 CLI plan 相近的章节。
  return [
    "Plan",
    "",
    "Goal",
    `- ${plan.goal}`,
    "",
    "Files To Inspect",
    ...plan.filesToInspect.map((file) => `- ${file}`),
    "",
    "Possible Tools",
    ...plan.possibleTools.map((tool) => `- ${tool}`),
    "",
    "Steps",
    ...plan.steps.map((step, index) => `${String(index + 1)}. ${step}`),
    "",
    "Risks",
    ...plan.risks.map((risk) => `- ${risk}`)
  ].join("\n");
}

function candidateFiles(srcTree: string[]): string[] {
  // 先从 src tree 中挑候选源码文件；没有 src 时回退到项目入口文档。
  const files = srcTree
    .map((entry) => entry.replace(/^\s*\[f\]\s+/, "").trim())
    .filter((entry) => entry.startsWith("src/"))
    .slice(0, 8);
  return files.length ? files : ["package.json", "README.md", "tsconfig.json"];
}
