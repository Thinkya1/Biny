/**
 * 轻量 Markdown 文本组件。
 *
 * 终端界面只需要少量 Markdown 支持：标题、列表、行内代码和粗体。这里把单行文本拆成 Ink
 * `Text` 片段，遇到无法闭合的标记时按普通文本处理。
 */
import React from "react";
import { Text, useWindowSize } from "ink";
import {
  diffLineStyle,
  padDiffLine,
  parseDiffCodeLine,
  parseDiffHeader,
  parseKimiDiffCodeLine,
  parseKimiDiffHeader,
  type DiffCodeLine,
  type DiffHeader,
  type KimiDiffCodeLine
} from "../diffLines.js";
import { diffPreviewStyles } from "../diffPreview.js";
import { colorToken, tuiColors, type ColorToken } from "../theme/index.js";

export interface MarkdownTextProps {
  line: string;
  muted?: boolean;
  color?: string;
}

type Segment =
  | { type: "text"; value: string }
  | { type: "action"; value: string }
  | { type: "bold"; value: string }
  | { type: "code"; value: string };

export function MarkdownText({ line, muted = false, color: textColor }: MarkdownTextProps): React.ReactElement {
  // 这里只支持终端友好的轻量 Markdown，不尝试完整解析 Markdown 语法。
  const { columns } = useWindowSize();
  const normalized = normalizeMarkdownLine(line);
  const style = diffLineStyle(normalized);
  const semanticStyle = semanticLineStyle(normalized);
  const displayLine = style?.fillBackground ? padDiffLine(normalized, Math.max(normalized.length, columns - 6)) : normalized;
  const kimiHeader = parseKimiDiffHeader(displayLine);
  if (kimiHeader) return <KimiDiffHeaderText header={kimiHeader} />;
  const header = parseDiffHeader(displayLine);
  if (header) return <DiffHeaderText header={header} />;

  const kimiCodeLine = parseKimiDiffCodeLine(displayLine);
  if (kimiCodeLine) return <KimiDiffCodeLineText line={kimiCodeLine} />;

  const codeLine = parseDiffCodeLine(displayLine);
  if (codeLine) return <DiffCodeLineText line={codeLine} color={style?.color} backgroundColor={style?.backgroundColor} />;

  const color = style?.color ?? (semanticStyle ? colorToken(semanticStyle.color) : textColor ?? (muted ? tuiColors.textDim : tuiColors.text));
  return (
    <Text color={color} backgroundColor={style?.backgroundColor} bold={style?.bold ?? semanticStyle?.bold} dimColor={style?.dimColor}>
      {parseInlineMarkdown(displayLine).map((segment, index) => {
        const key = `${segment.type}-${String(index)}`;
        if (segment.type === "action") return <Text key={key} color={tuiColors.accent} bold>{segment.value}</Text>;
        if (segment.type === "bold") return <Text key={key} bold>{segment.value}</Text>;
        if (segment.type === "code") return <Text key={key} color={tuiColors.primary}>{segment.value}</Text>;
        return <Text key={key}>{segment.value}</Text>;
      })}
    </Text>
  );
}

export function semanticLineStyle(line: string): { color: ColorToken; bold?: true } | undefined {
  const trimmed = line.trim();
  if (trimmed === "stdout:") return { color: "textStrong", bold: true };
  if (trimmed === "stderr:") return { color: "warning", bold: true };
  if (/^exit\s+0$/.test(trimmed)) return { color: "success", bold: true };
  if (/^exit\s+\d+$/.test(trimmed)) return { color: "error", bold: true };
  if (/^… \d+ lines \(ctrl \+ t to view transcript\)$/.test(trimmed)) return { color: "textMuted" };
  return undefined;
}

export function commandActionPrefix(line: string): string | undefined {
  const match = line.match(/^\s*(Ran|Read|Searched|Edited|Wrote|Checked|Viewed|Listed|Created|Deleted)\b/);
  return match?.[1];
}

function KimiDiffHeaderText({ header }: { header: { path: string; additions: number | undefined; deletions: number | undefined } }): React.ReactElement {
  const style = diffPreviewStyles.header;
  return (
    <Text bold>
      {header.additions === undefined ? null : <Text color={tokenColor(style.additions, "diffAddedStrong")}>+{String(header.additions)} </Text>}
      {header.deletions === undefined ? null : <Text color={tokenColor(style.deletions, "diffRemovedStrong")}>-{String(header.deletions)} </Text>}
      <Text color={tokenColor(style.path, "textStrong")}>{header.path}</Text>
    </Text>
  );
}

function DiffHeaderText({ header }: { header: DiffHeader }): React.ReactElement {
  return (
    <Text bold>
      <Text color={tuiColors.primary}>{header.operation}</Text>
      <Text> </Text>
      <Text color={tuiColors.textStrong}>{header.path}</Text>
      <Text> (</Text>
      {header.additions === undefined ? null : <Text color={tuiColors.diffAddedStrong}>+{String(header.additions)}</Text>}
      {header.additions !== undefined && header.deletions !== undefined ? <Text> </Text> : null}
      {header.deletions === undefined ? null : <Text color={tuiColors.diffRemovedStrong}>-{String(header.deletions)}</Text>}
      <Text>)</Text>
    </Text>
  );
}

function KimiDiffCodeLineText({ line }: { line: KimiDiffCodeLine }): React.ReactElement {
  const isAdd = line.prefix === "+";
  const isDelete = line.prefix === "-";
  const style = isAdd ? diffPreviewStyles.add : isDelete ? diffPreviewStyles.delete : diffPreviewStyles.context;
  const dimColor = "dimColor" in style ? style.dimColor : undefined;
  return (
    <Text>
      <Text color={tokenColor(style.gutter, "diffGutter")} dimColor>{line.lineColumn}</Text>
      <Text color={tokenColor(style.gutter, "diffGutter")} dimColor> </Text>
      <Text color={tokenColor(style.marker, "text")} dimColor={dimColor}>{line.prefix}</Text>
      <Text color={tokenColor(style.content, "text")} dimColor={dimColor}> {line.content}</Text>
    </Text>
  );
}

function DiffCodeLineText({ line, color, backgroundColor }: { line: DiffCodeLine; color?: string; backgroundColor?: string }): React.ReactElement {
  const isAdd = line.prefix === "+";
  const isDelete = line.prefix === "-";
  const contentColor = color ?? (isAdd || isDelete ? tuiColors.textStrong : tuiColors.diffMeta);
  return (
    <Text backgroundColor={backgroundColor}>
      <Text color={tuiColors.diffGutter} dimColor backgroundColor={backgroundColor}>{line.oldColumn}</Text>
      <Text color={tuiColors.diffGutter} dimColor backgroundColor={backgroundColor}> </Text>
      <Text color={tuiColors.diffGutter} dimColor backgroundColor={backgroundColor}>{line.newColumn}</Text>
      <Text color={tuiColors.diffGutter} dimColor backgroundColor={backgroundColor}> </Text>
      <Text color={contentColor} backgroundColor={backgroundColor} dimColor={!isAdd && !isDelete}>{line.prefix}</Text>
      <Text color={contentColor} backgroundColor={backgroundColor} dimColor={!isAdd && !isDelete}> {line.content}</Text>
    </Text>
  );
}

function normalizeMarkdownLine(line: string): string {
  // 标题去掉 #，无序列表转成项目符号，数字列表保留原始编号。
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading?.[2]) return heading[2];

  const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (bullet?.[2]) return `${bullet[1] ?? ""}• ${bullet[2]}`;

  const numbered = line.match(/^(\s*)\d+\.\s+(.+)$/);
  if (numbered?.[2]) return `${numbered[1] ?? ""}${line.trimStart()}`;

  return line;
}

function parseInlineMarkdown(line: string): Segment[] {
  // 行内解析只识别 `code` 和 **bold**，无法闭合的标记按普通文本处理。
  const segments: Segment[] = [];
  const action = commandActionPrefix(line);
  let initialIndex = 0;
  if (action) {
    const actionStart = line.indexOf(action);
    pushText(segments, line.slice(0, actionStart));
    segments.push({ type: "action", value: action });
    initialIndex = actionStart + action.length;
  }

  for (let index = initialIndex; index < line.length;) {
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
  // 返回最靠前的 Markdown token 起点，-1 表示没有可处理 token。
  if (codeStart === -1) return boldStart;
  if (boldStart === -1) return codeStart;
  return Math.min(codeStart, boldStart);
}

function pushText(segments: Segment[], value: string): void {
  // 跳过空字符串，避免 React 渲染无意义片段。
  if (!value) return;
  segments.push({ type: "text", value });
}

function tokenColor(token: ColorToken | undefined, fallback: ColorToken): string {
  return colorToken(token ?? fallback);
}
