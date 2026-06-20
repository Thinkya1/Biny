import { ensureAgentDirs } from "../../session/store.js";
import { listSessionSummaries } from "../../session/events.js";

export async function sessionsCommand(workspaceRoot: string): Promise<void> {
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
    const firstMessage = session.firstUserMessage.replace(/\s+/g, " ").slice(0, 80) || "(no user_message)";
    const lastAssistant = session.lastAssistantMessage.replace(/\s+/g, " ").slice(0, 80) || "(no assistant_message)";
    console.log(`${session.fileName}\t${session.createdAt}\t${relativeTime(session.updatedAt)}\t${session.eventCount} events`);
    console.log(`  user: ${firstMessage}`);
    console.log(`  biny: ${lastAssistant}`);
  }
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${String(Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${String(Math.floor(diff / hour))}h ago`;
  return `${String(Math.floor(diff / day))}d ago`;
}
