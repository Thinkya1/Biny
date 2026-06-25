export interface InputEditState {
  text: string;
  cursor: number;
}

export type InputEditAction =
  | { type: "insert"; value: string }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "line-start" }
  | { type: "line-end" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "delete-before" }
  | { type: "delete-after" };

export interface InputLineSegment {
  prefix: "> " | "  ";
  before: string;
  after: string;
  hasCursor: boolean;
}

export function editInputText(state: InputEditState, action: InputEditAction): InputEditState {
  const current = clampInputState(state);
  switch (action.type) {
    case "insert":
      return {
        text: `${current.text.slice(0, current.cursor)}${action.value}${current.text.slice(current.cursor)}`,
        cursor: current.cursor + action.value.length
      };
    case "move-left":
      return { text: current.text, cursor: Math.max(0, current.cursor - 1) };
    case "move-right":
      return { text: current.text, cursor: Math.min(current.text.length, current.cursor + 1) };
    case "line-start":
      return { text: current.text, cursor: lineStart(current.text, current.cursor) };
    case "line-end":
      return { text: current.text, cursor: lineEnd(current.text, current.cursor) };
    case "backspace":
      if (current.cursor === 0) return current;
      return {
        text: `${current.text.slice(0, current.cursor - 1)}${current.text.slice(current.cursor)}`,
        cursor: current.cursor - 1
      };
    case "delete":
      if (current.cursor >= current.text.length) return current;
      return {
        text: `${current.text.slice(0, current.cursor)}${current.text.slice(current.cursor + 1)}`,
        cursor: current.cursor
      };
    case "delete-before": {
      const start = lineStart(current.text, current.cursor);
      return {
        text: `${current.text.slice(0, start)}${current.text.slice(current.cursor)}`,
        cursor: start
      };
    }
    case "delete-after": {
      const end = lineEnd(current.text, current.cursor);
      return {
        text: `${current.text.slice(0, current.cursor)}${current.text.slice(end)}`,
        cursor: current.cursor
      };
    }
  }
}

export function inputLineSegments(text: string, cursor: number): InputLineSegment[] {
  const safeCursor = clampCursor(text, cursor);
  const lines = text.split("\n");
  const segments: InputLineSegment[] = [];
  let lineStartIndex = 0;

  lines.forEach((line, index) => {
    const lineEndIndex = lineStartIndex + line.length;
    const hasCursor = safeCursor >= lineStartIndex && safeCursor <= lineEndIndex;
    const cursorInLine = hasCursor ? safeCursor - lineStartIndex : line.length;
    segments.push({
      before: line.slice(0, cursorInLine),
      after: hasCursor ? line.slice(cursorInLine) : "",
      prefix: index === 0 ? "> " : "  ",
      hasCursor
    });
    lineStartIndex = lineEndIndex + 1;
  });

  return segments;
}

function clampInputState(state: InputEditState): InputEditState {
  return { text: state.text, cursor: clampCursor(state.text, state.cursor) };
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.min(Math.max(Math.trunc(cursor), 0), text.length);
}

function lineStart(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const previousBreak = text.lastIndexOf("\n", cursor - 1);
  return previousBreak === -1 ? 0 : previousBreak + 1;
}

function lineEnd(text: string, cursor: number): number {
  const nextBreak = text.indexOf("\n", cursor);
  return nextBreak === -1 ? text.length : nextBreak;
}
