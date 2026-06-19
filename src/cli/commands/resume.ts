import path from "node:path";
import { ensureAgentDirs, resolveSessionFile } from "../../session/store.js";
import { readSessionEvents } from "../../session/events.js";
import type { SessionEvent } from "../../session/recorder.js";

export async function resumeCommand(workspaceRoot: string, session: string | undefined): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  const filePath = await resolveSessionFile(workspaceRoot, session);
  const events = await readSessionEvents(filePath);

  console.log(`Session: ${path.relative(workspaceRoot, filePath)}`);
  for (const event of events) {
    printEvent(event);
  }
}

function printEvent(event: SessionEvent): void {
  const time = "time" in event && typeof event.time === "string" ? event.time : "";
  const prefix = time ? `[${time}] ${event.type}` : event.type;

  if (event.type === "user_message" || event.type === "assistant_message") {
    console.log(`${prefix}: ${event.content}`);
    return;
  }

  if (event.type === "tool_call") {
    console.log(`${prefix}: ${event.tool} ${JSON.stringify(event.args)}`);
    return;
  }

  if (event.type === "tool_result") {
    console.log(`${prefix}: ${event.tool} ${JSON.stringify(event.result)}`);
    return;
  }

  console.log(`${prefix}: ${event.message}`);
}
