/**
 * 内置主题调色板。
 *
 * 两套主题沿用 Pi 的配色：`vars` 声明基础色，`colors` 只做语义映射，
 * 因此调整某个基础色会同时影响所有引用它的语义 token。
 */
import type { ThemeDefinition } from "./tokens.js";

export const darkTheme: ThemeDefinition = {
  name: "dark",
  vars: {
    cyan: "#00d7ff",
    blue: "#5f87ff",
    green: "#b5bd68",
    red: "#cc6666",
    yellow: "#ffff00",
    text: "#d4d4d4",
    gray: "#808080",
    dimGray: "#666666",
    darkGray: "#505050",
    accent: "#8abeb7",
    selectedBg: "#3a3a4a",
    userMsgBg: "#343541",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
    customMsgBg: "#2d2838"
  },
  colors: {
    accent: "accent",
    border: "blue",
    borderAccent: "cyan",
    borderMuted: "darkGray",
    success: "green",
    error: "red",
    warning: "yellow",
    muted: "gray",
    dim: "dimGray",
    text: "text",
    thinkingText: "gray",

    selectedBg: "selectedBg",
    userMessageBg: "userMsgBg",
    userMessageText: "text",
    customMessageBg: "customMsgBg",
    customMessageText: "text",
    customMessageLabel: "#9575cd",
    toolPendingBg: "toolPendingBg",
    toolSuccessBg: "toolSuccessBg",
    toolErrorBg: "toolErrorBg",
    toolTitle: "text",
    toolOutput: "gray",

    mdHeading: "#f0c674",
    mdLink: "#81a2be",
    mdLinkUrl: "dimGray",
    mdCode: "accent",
    mdCodeBlock: "green",
    mdCodeBlockBorder: "gray",
    mdQuote: "gray",
    mdQuoteBorder: "gray",
    mdHr: "gray",
    mdListBullet: "accent",

    toolDiffAdded: "green",
    toolDiffRemoved: "red",
    toolDiffContext: "gray",

    syntaxComment: "#6A9955",
    syntaxKeyword: "#569CD6",
    syntaxFunction: "#DCDCAA",
    syntaxVariable: "#9CDCFE",
    syntaxString: "#CE9178",
    syntaxNumber: "#B5CEA8",
    syntaxType: "#4EC9B0",
    syntaxOperator: "#D4D4D4",
    syntaxPunctuation: "#D4D4D4",

    thinkingOff: "darkGray",
    thinkingMinimal: "#6e6e6e",
    thinkingLow: "#5f87af",
    thinkingMedium: "#81a2be",
    thinkingHigh: "#b294bb",
    thinkingXhigh: "#d183e8",
    thinkingMax: "#ff5fff",

    bashMode: "green"
  },
  export: {
    pageBg: "#18181e",
    cardBg: "#1e1e24",
    infoBg: "#3c3728"
  }
};

export const lightTheme: ThemeDefinition = {
  name: "light",
  vars: {
    teal: "#5a8080",
    blue: "#547da7",
    green: "#588458",
    red: "#aa5555",
    yellow: "#9a7326",
    text: "#1f2328",
    mediumGray: "#6c6c6c",
    dimGray: "#767676",
    lightGray: "#b0b0b0",
    selectedBg: "#d0d0e0",
    userMsgBg: "#e8e8e8",
    toolPendingBg: "#e8e8f0",
    toolSuccessBg: "#e8f0e8",
    toolErrorBg: "#f0e8e8",
    customMsgBg: "#ede7f6"
  },
  colors: {
    accent: "teal",
    border: "blue",
    borderAccent: "teal",
    borderMuted: "lightGray",
    success: "green",
    error: "red",
    warning: "yellow",
    muted: "mediumGray",
    dim: "dimGray",
    text: "text",
    thinkingText: "mediumGray",

    selectedBg: "selectedBg",
    userMessageBg: "userMsgBg",
    userMessageText: "text",
    customMessageBg: "customMsgBg",
    customMessageText: "text",
    customMessageLabel: "#7e57c2",
    toolPendingBg: "toolPendingBg",
    toolSuccessBg: "toolSuccessBg",
    toolErrorBg: "toolErrorBg",
    toolTitle: "text",
    toolOutput: "mediumGray",

    mdHeading: "yellow",
    mdLink: "blue",
    mdLinkUrl: "dimGray",
    mdCode: "teal",
    mdCodeBlock: "green",
    mdCodeBlockBorder: "mediumGray",
    mdQuote: "mediumGray",
    mdQuoteBorder: "mediumGray",
    mdHr: "mediumGray",
    mdListBullet: "green",

    toolDiffAdded: "green",
    toolDiffRemoved: "red",
    toolDiffContext: "mediumGray",

    syntaxComment: "#008000",
    syntaxKeyword: "#0000FF",
    syntaxFunction: "#795E26",
    syntaxVariable: "#001080",
    syntaxString: "#A31515",
    syntaxNumber: "#098658",
    syntaxType: "#267F99",
    syntaxOperator: "#000000",
    syntaxPunctuation: "#000000",

    thinkingOff: "lightGray",
    thinkingMinimal: "#767676",
    thinkingLow: "blue",
    thinkingMedium: "teal",
    thinkingHigh: "#875f87",
    thinkingXhigh: "#8b008b",
    thinkingMax: "#af005f",

    bashMode: "green"
  },
  export: {
    pageBg: "#f8f8f8",
    cardBg: "#ffffff",
    infoBg: "#fffae6"
  }
};

export const builtInThemes: Record<string, ThemeDefinition> = {
  dark: darkTheme,
  light: lightTheme
};
