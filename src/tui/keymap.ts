/**
 * TUI 快捷键常量模块。
 *
 * 权限确认框使用的按键集中定义在这里，组件只引用语义化字段，避免到处散落 `y`、`n`
 * 这样的魔法字符。
 */
export const TUI_KEYS = {
  // 权限提示快捷键集中定义，避免组件里散落魔法字符。
  approve: "y",
  reject: "n"
} as const;
