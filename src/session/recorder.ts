import { createWriteStream, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { sessionFilePath } from "./store.js";

export type SessionEvent = Record<string, unknown> & { type: string; time?: string };

export class SessionRecorder {
  readonly sessionId: string;
  readonly filePath: string;
  private readonly stream: WriteStream;

  constructor(workspaceRoot: string) {
    this.sessionId = createSessionId();
    this.filePath = sessionFilePath(workspaceRoot, this.sessionId);
    this.stream = createWriteStream(this.filePath, { flags: "a" });
  }

  record(event: SessionEvent): void {
    const line = JSON.stringify({ ...event, time: event.time ?? new Date().toISOString() });
    this.stream.write(`${line}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function createSessionId(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}
