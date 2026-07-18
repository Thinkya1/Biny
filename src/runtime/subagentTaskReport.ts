import type { SubagentTaskSnapshot } from "./SubagentTaskManager.js";

export function formatSubagentTaskReport(tasks: readonly SubagentTaskSnapshot[]): string {
  if (!tasks.length) return "No subagent tasks have been submitted in this runtime.";

  return [...tasks]
    .reverse()
    .map((task) => {
      const details = [
        `  ${singleLine(task.task, 240)}`,
        `  parent ${task.parentRunId} · deadline ${task.deadline}`
      ];
      if (task.error) details.push(`  error ${singleLine(task.error, 240)}`);
      return [`${task.taskId} · ${task.status}`, ...details].join("\n");
    })
    .join("\n\n");
}

function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
