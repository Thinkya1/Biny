/**
 * Terminal text layout helpers.
 *
 * ANSI control sequences have no display width. Printable text is measured by
 * grapheme so combining marks and emoji sequences are never split, while CJK
 * and other full-width characters occupy two terminal columns.
 */

const ansiReset = "\u001B[0m";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation = /\p{Emoji_Presentation}/u;
const regionalIndicator = /\p{Regional_Indicator}/u;
const markOnly = /^\p{Mark}+$/u;

type TerminalToken =
  | { kind: "ansi"; value: string }
  | { kind: "grapheme"; value: string; width: number }
  | { kind: "newline" };

export function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length;) {
    const ansiLength = ansiSequenceLength(text, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }
    result += text[index] ?? "";
    index += 1;
  }
  return result;
}

export function terminalWidth(text: string): number {
  let width = 0;
  for (const token of terminalTokens(text)) {
    if (token.kind === "grapheme") width += token.width;
  }
  return width;
}

export function truncateToTerminalWidth(text: string, width: number, ellipsis = "…"): string {
  const availableWidth = normalizedWidth(width);
  if (availableWidth === 0) return "";
  if (terminalWidth(text) <= availableWidth) return text;

  const fittedEllipsis = prefixWithinWidth(ellipsis, availableWidth).text;
  const contentWidth = Math.max(0, availableWidth - terminalWidth(fittedEllipsis));
  const prefix = prefixWithinWidth(text, contentWidth).text;
  return closeActiveSgr(`${prefix}${fittedEllipsis}`);
}

export function wrapTerminalLines(text: string, width: number): string[] {
  const availableWidth = Math.max(1, normalizedWidth(width));
  const lines: string[] = [];
  let activeSgr = "";
  let current = "";
  let currentWidth = 0;

  const pushLine = (): void => {
    lines.push(activeSgr ? `${current}${ansiReset}` : current);
    current = activeSgr;
    currentWidth = 0;
  };

  for (const token of terminalTokens(text)) {
    if (token.kind === "ansi") {
      current += token.value;
      activeSgr = nextSgrState(activeSgr, token.value);
      continue;
    }
    if (token.kind === "newline") {
      pushLine();
      continue;
    }
    if (token.width > availableWidth) {
      if (currentWidth > 0) pushLine();
      const replacement = prefixWithinWidth("…", availableWidth).text;
      current += replacement;
      currentWidth += terminalWidth(replacement);
      continue;
    }
    if (token.width > 0 && currentWidth > 0 && currentWidth + token.width > availableWidth) {
      pushLine();
    }
    current += token.value;
    currentWidth += token.width;
  }

  lines.push(activeSgr ? `${current}${ansiReset}` : current);
  return lines;
}

export function clampTerminalLines(
  text: string,
  width: number,
  maxLines: number
): { lines: string[]; hiddenLines: number } {
  const wrapped = wrapTerminalLines(text, width);
  const limit = normalizedWidth(maxLines);
  return {
    lines: wrapped.slice(0, limit),
    hiddenLines: Math.max(0, wrapped.length - limit)
  };
}

function terminalTokens(text: string): TerminalToken[] {
  const tokens: TerminalToken[] = [];
  let plainText = "";

  const flushPlainText = (): void => {
    if (!plainText) return;
    for (const entry of graphemeSegmenter.segment(plainText)) {
      if (entry.segment === "\n" || entry.segment === "\r" || entry.segment === "\r\n") {
        tokens.push({ kind: "newline" });
      } else {
        tokens.push({ kind: "grapheme", value: entry.segment, width: graphemeWidth(entry.segment) });
      }
    }
    plainText = "";
  };

  for (let index = 0; index < text.length;) {
    const ansiLength = ansiSequenceLength(text, index);
    if (ansiLength === 0) {
      plainText += text[index] ?? "";
      index += 1;
      continue;
    }
    flushPlainText();
    tokens.push({ kind: "ansi", value: text.slice(index, index + ansiLength) });
    index += ansiLength;
  }
  flushPlainText();
  return tokens;
}

function prefixWithinWidth(text: string, width: number): { text: string; width: number } {
  let result = "";
  let usedWidth = 0;
  for (const token of terminalTokens(text)) {
    if (token.kind === "ansi") {
      result += token.value;
      continue;
    }
    if (token.kind === "newline") {
      result += "\n";
      continue;
    }
    if (usedWidth + token.width > width) break;
    result += token.value;
    usedWidth += token.width;
  }
  return { text: result, width: usedWidth };
}

function closeActiveSgr(text: string): string {
  let activeSgr = "";
  for (const token of terminalTokens(text)) {
    if (token.kind === "ansi") activeSgr = nextSgrState(activeSgr, token.value);
  }
  return activeSgr ? `${text}${ansiReset}` : text;
}

function nextSgrState(activeSgr: string, sequence: string): string {
  const match = sequence.match(/^(?:\u001B\[|\u009B)([\d:;]*)m$/u);
  if (!match) return activeSgr;
  const parameters = match[1] ?? "";
  if (parameters === "" || parameters === "0") return "";
  return `${activeSgr}${sequence}`;
}

function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (emojiPresentation.test(grapheme)
    || regionalIndicator.test(grapheme)
    || grapheme.includes("\uFE0F")
    || grapheme.includes("\u20E3")) {
    return 2;
  }
  if (markOnly.test(grapheme)) return 0;

  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue;
    return isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return 0;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1F
    || (codePoint >= 0x7F && codePoint <= 0x9F)
    || codePoint === 0x200B
    || codePoint === 0x200C
    || codePoint === 0x200D
    || codePoint === 0x2060
    || codePoint === 0xFEFF
    || (codePoint >= 0xFE00 && codePoint <= 0xFE0F)
    || (codePoint >= 0xE0100 && codePoint <= 0xE01EF);
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115F
    || codePoint === 0x2329
    || codePoint === 0x232A
    || (codePoint >= 0x2E80 && codePoint <= 0x303E)
    || (codePoint >= 0x3040 && codePoint <= 0xA4CF && codePoint !== 0x303F)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x1B000 && codePoint <= 0x1B2FF)
    || (codePoint >= 0x1F200 && codePoint <= 0x1F251)
    || (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
  );
}

function normalizedWidth(width: number): number {
  if (!Number.isFinite(width)) return width === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(width));
}

function ansiSequenceLength(text: string, index: number): number {
  const codePoint = text.charCodeAt(index);
  if (codePoint === 0x1B) return escapeSequenceLength(text, index);
  if (codePoint === 0x9B) return csiSequenceLength(text, index + 1) + 1;
  if (codePoint === 0x9D) return stringControlLength(text, index + 1) + 1;
  if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9E || codePoint === 0x9F) {
    return stringControlLength(text, index + 1) + 1;
  }
  return 0;
}

function escapeSequenceLength(text: string, index: number): number {
  const next = text.charCodeAt(index + 1);
  if (Number.isNaN(next)) return 1;
  if (next === 0x5B) return csiSequenceLength(text, index + 2) + 2;
  if (next === 0x5D || next === 0x50 || next === 0x58 || next === 0x5E || next === 0x5F) {
    return stringControlLength(text, index + 2) + 2;
  }

  let cursor = index + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x30 && code <= 0x7E) break;
  }
  return cursor - index;
}

function csiSequenceLength(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7E) break;
  }
  return cursor - start;
}

function stringControlLength(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 0x07 || code === 0x9C) return cursor - start + 1;
    if (code === 0x1B && text.charCodeAt(cursor + 1) === 0x5C) return cursor - start + 2;
    cursor += 1;
  }
  return text.length - start;
}
