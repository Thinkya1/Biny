import type { TranscriptState } from "./types.js";

export interface ExpandableTranscript {
  title: string;
  content: string;
}

export function latestExpandableTranscript(transcript: TranscriptState): ExpandableTranscript | undefined {
  const items = [...transcript.committed, ...transcript.active];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "tool" && item.details) {
      return { title: item.title, content: item.details };
    }
  }
  return undefined;
}
