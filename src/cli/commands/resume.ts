/**
 * 会话恢复打印模块。
 *
 * `resume` 可以接受 latest、session id 前缀或 JSONL 路径，然后按事件顺序打印历史用户消息、
 * assistant 消息、工具调用、工具结果和错误，帮助用户在普通终端里回看 session。
 */
import path from "node:path";
import { readStoredSessionEvents } from "../../session/events.js";
import { ensureAgentDirs } from "../../session/store.js";
import type { SessionEvent } from "../../session/recorder.js";

export async function resumeCommand(workspaceRoot: string, session: string | undefined): Promise<void> {
  // resume 支持 latest、session id 前缀或 jsonl 文件路径，解析逻辑集中在 store。
  await ensureAgentDirs(workspaceRoot);
  const { filePath, events } = await readStoredSessionEvents(workspaceRoot, session);

  console.log(`Session: ${path.relative(workspaceRoot, filePath)}`);
  for (const event of events) {
    printEvent(event);
  }
}

function printEvent(event: SessionEvent): void {
  // 恢复输出保留事件类型，方便定位一次对话中的工具调用和错误。
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
