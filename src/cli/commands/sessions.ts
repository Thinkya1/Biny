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
    console.log(`${session.fileName}\t${session.createdAt}\t${session.eventCount} events\t${firstMessage}`);
  }
}
