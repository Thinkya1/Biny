export interface ColorPalette {
  primary: string;
  accent: string;
  accentAssistant: string;
  accentThinking: string;
  accentTool: string;
  accentRunning: string;
  text: string;
  textStrong: string;
  textDim: string;
  textMuted: string;
  border: string;
  borderFocus: string;
  promptBorder: string;
  promptBorderFocus: string;
  success: string;
  warning: string;
  error: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedStrong: string;
  diffRemovedStrong: string;
  diffGutter: string;
  diffMeta: string;
  roleUser: string;
}

/** GrokNight-inspired neutral dark palette with magenta accents. */
export const darkColors: ColorPalette = {
  primary: "#bb9af7",
  accent: "#7dcfff",
  accentAssistant: "#bb9af7",
  accentThinking: "#bb9af7",
  accentTool: "#787878",
  accentRunning: "#bb9af7",

  text: "#e1e1e1",
  textStrong: "#f3f3f3",
  textDim: "#c8c8c8",
  textMuted: "#6c6c6c",

  border: "#5a5a5a",
  borderFocus: "#e0af68",
  promptBorder: "#323237",
  promptBorderFocus: "#505058",

  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",

  diffAdded: "#9ece6a",
  diffRemoved: "#f7768e",
  diffAddedStrong: "#b9f27c",
  diffRemovedStrong: "#ff9eae",
  diffGutter: "#6c6c6c",
  diffMeta: "#787878",

  roleUser: "#c8c8c8"
};

export const lightColors: ColorPalette = {
  primary: "#7c3aed",
  accent: "#0284c7",
  accentAssistant: "#7c3aed",
  accentThinking: "#7c3aed",
  accentTool: "#64748b",
  accentRunning: "#7c3aed",

  text: "#1a1a1a",
  textStrong: "#0f0f0f",
  textDim: "#3f3f46",
  textMuted: "#71717a",

  border: "#a1a1aa",
  borderFocus: "#b45309",
  promptBorder: "#d4d4d8",
  promptBorderFocus: "#a1a1aa",

  success: "#15803d",
  warning: "#b45309",
  error: "#be123c",

  diffAdded: "#15803d",
  diffRemoved: "#be123c",
  diffAddedStrong: "#15803d",
  diffRemovedStrong: "#be123c",
  diffGutter: "#a1a1aa",
  diffMeta: "#71717a",

  roleUser: "#52525b"
};

export type ResolvedTheme = "dark" | "light";

export type ColorToken = keyof ColorPalette;

export const tuiColors = darkColors;

export function colorToken(token: ColorToken): string {
  return tuiColors[token];
}

export function getBuiltInPalette(resolved: ResolvedTheme): ColorPalette {
  return resolved === "dark" ? darkColors : lightColors;
}
