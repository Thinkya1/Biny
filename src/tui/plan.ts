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
  const files = srcTree
    .map((entry) => entry.replace(/^\s*\[f\]\s+/, "").trim())
    .filter((entry) => entry.startsWith("src/"))
    .slice(0, 8);
  return files.length ? files : ["package.json", "README.md", "tsconfig.json"];
}
