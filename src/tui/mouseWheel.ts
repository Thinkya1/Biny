/**
 * Terminal mouse-wheel helpers.
 *
 * Without mouse tracking, many terminals map the wheel to ↑/↓, which collides
 * with input history. Enabling SGR mouse mode makes the wheel emit distinct
 * sequences so arrow keys can stay "previous/next prompt".
 *
 * Ink's useInput strips the leading ESC from CSI sequences before handlers run,
 * so reports arrive as `[<64;x;yM` / `[M...` rather than `\x1b[<64;x;yM`.
 */

/** Enable basic + SGR mouse reporting (wheel becomes buttons 64/65). */
export const enableMouseTrackingSeq = "\u001B[?1000h\u001B[?1006h";

/** Disable mouse reporting on TUI exit. */
export const disableMouseTrackingSeq = "\u001B[?1000l\u001B[?1006l";

/** Strip a leading ESC so raw CSI and Ink-delivered payloads share one shape. */
function mousePayload(input: string): string {
  return input.startsWith("\u001B") ? input.slice(1) : input;
}

/**
 * True when `input` is a terminal mouse report (wheel, click, drag, release).
 * Used to keep SGR/X10 junk out of the prompt text field.
 */
export function isMouseReport(input: string): boolean {
  const payload = mousePayload(input);
  if (/\[<\d+(?:;\d+){0,2}[Mm]/.test(payload)) return true;
  // X10 legacy: [M + button + x + y (3 bytes after M)
  if (/\[M[\s\S]{3}/.test(payload)) return true;
  return false;
}

/**
 * Parse one or more SGR mouse reports from a raw input chunk.
 * Returns scroll direction for the last wheel event found:
 *   1 = toward older content (wheel up)
 *  -1 = toward newer content (wheel down)
 */
export function parseMouseWheelDirection(input: string): 1 | -1 | undefined {
  const payload = mousePayload(input);
  if (!payload.includes("[<") && !payload.includes("[M")) return undefined;

  let direction: 1 | -1 | undefined;

  // SGR: [ < button ; x ; y M/m  (ESC already stripped by Ink, or by mousePayload)
  const sgr = /\[<(\d+);\d+;\d+[Mm]/g;
  for (const match of payload.matchAll(sgr)) {
    const button = Number(match[1]);
    if (isWheelUp(button)) direction = 1;
    else if (isWheelDown(button)) direction = -1;
  }

  // X10 legacy: [ M Cb Cx Cy
  const x10 = /\[M([\s\S]{3})/g;
  for (const match of payload.matchAll(x10)) {
    const chunk = match[1];
    if (!chunk || chunk.length < 1) continue;
    const button = chunk.charCodeAt(0) - 32;
    if (isWheelUp(button)) direction = 1;
    else if (isWheelDown(button)) direction = -1;
  }

  return direction;
}

function isWheelUp(button: number): boolean {
  // 64 + modifier flags (4 shift, 8 meta, 16 ctrl)
  return (button & ~28) === 64;
}

function isWheelDown(button: number): boolean {
  return (button & ~28) === 65;
}

export function installMouseWheelTracking(stdout: NodeJS.WriteStream = process.stdout): () => void {
  if (!stdout.isTTY) return () => undefined;
  stdout.write(enableMouseTrackingSeq);
  return () => {
    try {
      stdout.write(disableMouseTrackingSeq);
    } catch {
      // best-effort cleanup
    }
  };
}
