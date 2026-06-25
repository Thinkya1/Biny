/**
 * TUI 输入历史模块。
 *
 * 用户提交过的输入会追加到 `.agent/input-history.jsonl`，再次打开 TUI 后可以加载最近记录用于上下键召回。
 * 历史只保存非空输入，并限制在最近一百条。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const maxHistoryItems = 100;

export async function loadInputHistory(workspaceRoot: string): Promise<string[]> {
  // 输入历史用 JSONL 追加存储，读取时只保留最近 maxHistoryItems 条有效输入。
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
    // 首次运行没有历史文件是正常状态，返回空数组即可。
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendInputHistory(workspaceRoot: string, input: string): Promise<void> {
  // 空白输入不进历史，避免上下键召回无意义内容。
  const value = input.trim();
  if (!value) return;
  await fs.mkdir(path.join(workspaceRoot, ".agent"), { recursive: true });
  await fs.appendFile(historyFilePath(workspaceRoot), `${JSON.stringify({ createdAt: new Date().toISOString(), input: value })}\n`);
}

function historyFilePath(workspaceRoot: string): string {
  // 历史文件放在 .agent 下，和 session/logs 同属本地运行产物。
  return path.join(workspaceRoot, ".agent", "input-history.jsonl");
}
