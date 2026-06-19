export function createUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  if (oldContent === newContent) return `(no changes in ${filePath})`;

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
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
  if (!content) return [];
  return content.replace(/\n$/, "").split("\n");
}
