/**
 * Session transcript 转换模块。
 *
 * 历史 session 中的 JSONL 事件会在这里转换成 TUI 消息：用户和 assistant 消息保持原角色，
 * 工具调用与工具结果压缩成 system 摘要，错误事件转换成 error 消息。
 */
import path from "node:path";
import type { SessionEvent } from "../session/recorder.js";
import { summarizeToolOutput } from "./toolOutputSummary.js";

export interface TranscriptMessage {
  // TranscriptMessage 是 session 事件转换后的 UI 消息形态。
  role: "user" | "assistant" | "system" | "error";
  content: string;
  fullTitle?: string;
  fullContent?: string;
}

export function sessionIdFromFile(filePath: string): string {
  // session 文件名去掉 .jsonl 后就是 recorder 使用的 sessionId。
  return path.basename(filePath, ".jsonl");
}

export function sessionEventsToMessages(workspaceRoot: string, filePath: string, events: SessionEvent[]): TranscriptMessage[] {
  // 恢复历史时先插入一条 system 消息，告诉用户当前查看的是哪个 session。
  const messages: TranscriptMessage[] = [
    {
      role: "system",
      content: `Resumed session ${sessionIdFromFile(filePath)}\n${path.relative(workspaceRoot, filePath)}`
    }
  ];

  for (const event of events) {
    // 用户和 assistant 消息按原角色恢复；工具调用只保留结果摘要，避免回放时展示原始 JSON 参数。
    if (event.type === "user_message") {
      messages.push({ role: "user", content: event.content });
      continue;
    }

    if (event.type === "assistant_message") {
      messages.push({ role: "assistant", content: event.content });
      continue;
    }

    if (event.type === "tool_call") {
      continue;
    }

    if (event.type === "tool_result") {
      messages.push({ role: "system", ...summarizeToolResult(event.tool, event.result) });
      continue;
    }

    messages.push({ role: "error", content: event.message });
  }

  return messages;
}

function summarizeToolResult(tool: string, value: unknown): Pick<TranscriptMessage, "content" | "fullTitle" | "fullContent"> {
  const output = summarizeToolOutput(tool, value, "", undefined);
  const content = output.fullTitle && !output.summary.startsWith(output.fullTitle)
    ? `${output.fullTitle}\n${output.summary}`
    : output.summary || summarize(value);
  return {
    content,
    fullTitle: output.fullTitle,
    fullContent: output.fullContent
  };
}

function summarize(value: unknown): string {
  // 工具事件摘要比实时工具视图略长，方便历史恢复时看清参数和结果。
  if (typeof value === "string") return value.slice(0, 800);
  try {
    return JSON.stringify(value, null, 2).slice(0, 800);
  } catch {
    return String(value).slice(0, 800);
  }
}
