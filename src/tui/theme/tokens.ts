/**
 * 主题 token 定义。
 *
 * Token 集按语义命名前景色，背景色单独成组，
 * 主题文件通过 `vars` 间接引用具体色值，组件只使用 token，不接触十六进制。
 */

/** 前景色 token。 */
export type ThemeColor =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "thinkingText"
  | "userMessageText"
  | "customMessageText"
  | "customMessageLabel"
  | "toolTitle"
  | "toolOutput"
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "syntaxComment"
  | "syntaxKeyword"
  | "syntaxFunction"
  | "syntaxVariable"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax"
  | "bashMode";

/** 背景色 token。 */
export type ThemeBg =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

/** 组件可用的全部颜色 token。 */
export type ColorToken = ThemeColor | ThemeBg;

/** 主题文件中的色值：十六进制、`vars` 引用名，或 256 色索引。 */
export type ColorValue = string | number;

/** 主题定义，基础色和语义色分层维护。 */
export interface ThemeDefinition {
  name: string;
  /** 命名色板，`colors` 中可直接引用这些名字。 */
  vars?: Record<string, ColorValue>;
  colors: Record<ThemeColor, ColorValue> & Record<ThemeBg, ColorValue>;
  /** 导出到桌面端 / HTML 分享时使用的页面色，TUI 本身不渲染。 */
  export?: {
    pageBg?: ColorValue;
    cardBg?: ColorValue;
    infoBg?: ColorValue;
  };
}

export const themeColorTokens: readonly ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode"
];

export const themeBgTokens: readonly ThemeBg[] = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg"
];

export function isThemeBgToken(token: ColorToken): token is ThemeBg {
  return (themeBgTokens as readonly string[]).includes(token);
}
