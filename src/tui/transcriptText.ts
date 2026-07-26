/**
 * Transcript 文案工具。
 *
 * 与渲染框架无关的纯函数：耗时格式化、thinking 标题、可折叠条目筛选。
 */
import type { ReasoningTranscriptItem, TranscriptItem, TranscriptState } from "./types.js";

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `${String(Math.max(0, Math.round(durationMs)))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainder)}s`;
}

export function thinkingHeaderLabel(item: ReasoningTranscriptItem, running: boolean): string {
  if (running) {
    const live = item.startedAtMs === undefined ? undefined : Math.max(0, Date.now() - item.startedAtMs);
    const duration = formatToolDuration(live);
    return duration ? `Thinking… ${duration}` : "Thinking…";
  }
  const duration = formatToolDuration(item.durationMs);
  return duration ? `Thought for ${duration}` : "Thought";
}

/** 可以展开或折叠的条目：工具调用和 thinking。 */
export function foldableTranscriptItems(transcript: TranscriptState): TranscriptItem[] {
  return [...transcript.committed, ...transcript.active].filter((item) =>
    item.kind === "tool" || item.kind === "reasoning"
  );
}

export interface ExpandableTranscript {
  title: string;
  content: string;
}

/** 最近一次可以查看详情的工具调用，供 ctrl+o 打开详情弹层。 */
export function latestExpandableTranscript(transcript: TranscriptState): ExpandableTranscript | undefined {
  const items = [...transcript.committed, ...transcript.active];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "tool") continue;
    const content = item.details ?? item.output;
    if (!content) continue;
    return { title: item.title, content };
  }
  return undefined;
}
