/**
 * 会话列表命令模块。
 *
 * `sessions` 读取本项目 `.agent/sessions` 下的 JSONL 文件，展示每个 session 的创建时间、
 * 最近更新时间、事件数、首条用户消息和最后一条 assistant 消息摘要。
 */
import { ensureAgentDirs } from "../../session/store.js";
import { listSessionSummaries } from "../../session/events.js";

export async function sessionsCommand(workspaceRoot: string): Promise<void> {
  // sessions 命令会先确保目录存在，这样新项目也能给出友好的空列表。
  await ensureAgentDirs(workspaceRoot);
  const sessions = await listSessionSummaries(workspaceRoot);
  printSessionSummaries(sessions);
}

export function printSessionSummaries(sessions: Awaited<ReturnType<typeof listSessionSummaries>>): void {
  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  for (const session of sessions) {
    // 摘要压成单行，避免长对话内容把 session 列表冲散。
    const firstMessage = session.firstUserMessage.replace(/\s+/g, " ").slice(0, 80) || "(no user_message)";
    const lastAssistant = session.lastAssistantMessage.replace(/\s+/g, " ").slice(0, 80) || "(no assistant_message)";
    console.log(`${session.fileName}\t${session.createdAt}\t${relativeTime(session.updatedAt)}\t${session.eventCount} events`);
    console.log(`  user: ${firstMessage}`);
    console.log(`  biny: ${lastAssistant}`);
  }
}

function relativeTime(value: string): string {
  // 简单相对时间只用于列表展示，不参与任何排序或恢复逻辑。
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
