import type { TuiMessage } from "./types.js";

export interface ExpandableTranscript {
  title: string;
  content: string;
}

export function latestExpandableTranscript(messages: readonly TuiMessage[]): ExpandableTranscript | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.fullContent && message.fullContent.length > 0) {
      return {
        title: message.fullTitle ?? "Transcript",
        content: message.fullContent
      };
    }
  }
  return undefined;
}
