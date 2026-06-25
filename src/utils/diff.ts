/**
 * 轻量 diff 生成模块。
 *
 * 这里生成的 unified diff 主要用于写入或编辑前的权限确认展示。它不追求完整 git diff hunk
 * 元数据，只需要让用户清楚看到旧内容和新内容的逐行差异。
 */
export function createUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return `(no changes in ${filePath})`;

  // 这里生成的是给确认提示用的轻量 diff，不追求完整 git diff hunk 元数据。
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldHeader = oldContent ? `a/${filePath}` : "/dev/null";
  const lines = [`--- ${oldHeader}`, `+++ b/${filePath}`, "@@"];
  const max = Math.max(oldLines.length, newLines.length);

  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine && oldLine !== undefined) {
      lines.push(` ${oldLine}`);
      continue;
    }
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
  }

  return lines.join("\n");
}

function splitLines(content: string): string[] {
  // 去掉最后一个换行，避免常见文本文件被额外显示一行空 diff。
  if (!content) return [];
  return content.replace(/\n$/, "").split("\n");
}
