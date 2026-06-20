import React from "react";
import { Text } from "ink";

export interface MarkdownTextProps {
  line: string;
  muted?: boolean;
}

type Segment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code"; value: string };

export function MarkdownText({ line, muted = false }: MarkdownTextProps): React.ReactElement {
  const normalized = normalizeMarkdownLine(line);
  return (
    <Text color={muted ? "gray" : undefined}>
      {parseInlineMarkdown(normalized).map((segment, index) => {
        const key = `${segment.type}-${String(index)}`;
        if (segment.type === "bold") return <Text key={key} bold>{segment.value}</Text>;
        if (segment.type === "code") return <Text key={key} color="yellow">{segment.value}</Text>;
        return <Text key={key}>{segment.value}</Text>;
      })}
    </Text>
  );
}

function normalizeMarkdownLine(line: string): string {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading?.[2]) return heading[2];

  const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (bullet?.[2]) return `${bullet[1] ?? ""}• ${bullet[2]}`;

  const numbered = line.match(/^(\s*)\d+\.\s+(.+)$/);
  if (numbered?.[2]) return `${numbered[1] ?? ""}${line.trimStart()}`;

  return line;
}

function parseInlineMarkdown(line: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;

  while (index < line.length) {
    const codeStart = line.indexOf("`", index);
    const boldStart = line.indexOf("**", index);
    const next = nextToken(codeStart, boldStart);
    if (next === -1) {
      pushText(segments, line.slice(index));
      break;
    }

    pushText(segments, line.slice(index, next));
    if (next === codeStart) {
      const end = line.indexOf("`", codeStart + 1);
      if (end === -1) {
        pushText(segments, line.slice(next));
        break;
      }
      segments.push({ type: "code", value: line.slice(codeStart + 1, end) });
      index = end + 1;
      continue;
    }

    const end = line.indexOf("**", boldStart + 2);
    if (end === -1) {
      pushText(segments, line.slice(next));
      break;
    }
    segments.push({ type: "bold", value: line.slice(boldStart + 2, end) });
    index = end + 2;
  }

  return segments;
}

function nextToken(codeStart: number, boldStart: number): number {
  if (codeStart === -1) return boldStart;
  if (boldStart === -1) return codeStart;
  return Math.min(codeStart, boldStart);
}

function pushText(segments: Segment[], value: string): void {
  if (!value) return;
  segments.push({ type: "text", value });
}
