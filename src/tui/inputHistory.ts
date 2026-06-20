import { promises as fs } from "node:fs";
import path from "node:path";

const maxHistoryItems = 100;

export async function loadInputHistory(workspaceRoot: string): Promise<string[]> {
  try {
    const content = await fs.readFile(historyFilePath(workspaceRoot), "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { input?: string })
      .map((item) => item.input)
      .filter((input): input is string => typeof input === "string" && input.trim().length > 0)
      .slice(-maxHistoryItems);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendInputHistory(workspaceRoot: string, input: string): Promise<void> {
  const value = input.trim();
  if (!value) return;
  await fs.mkdir(path.join(workspaceRoot, ".agent"), { recursive: true });
  await fs.appendFile(historyFilePath(workspaceRoot), `${JSON.stringify({ createdAt: new Date().toISOString(), input: value })}\n`);
}

function historyFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent", "input-history.jsonl");
}
