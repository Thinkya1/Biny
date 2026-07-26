/**
 * 界面字体偏好的共享约定：默认值与合法范围。
 *
 * 主进程（持久化校验）与渲染层（设置面板输入夹取）都依赖同一份边界，避免两端各写一套
 * 导致存进去的值和界面允许的值不一致。字号以 14px 为设计基准，渲染层按 size/14 等比缩放。
 */
import type { DesktopFontPreference } from "./protocol.js";

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;
export const BASE_FONT_SIZE = 14;
/** family 取该值时跟随操作系统字体，不注入自定义字体族。 */
export const SYSTEM_FONT_FAMILY = "system";

export const DEFAULT_FONT_PREFERENCE: DesktopFontPreference = {
  family: SYSTEM_FONT_FAMILY,
  size: BASE_FONT_SIZE
};

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return BASE_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/** 从不可信来源（落盘文件）恢复字体偏好，字段不合法时逐项回退默认值。 */
export function normalizeFontPreference(value: unknown): DesktopFontPreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_FONT_PREFERENCE };
  const raw = value as Partial<DesktopFontPreference>;
  return {
    family: typeof raw.family === "string" && raw.family.length > 0 && raw.family.length <= 100 ? raw.family : SYSTEM_FONT_FAMILY,
    size: typeof raw.size === "number" ? clampFontSize(raw.size) : BASE_FONT_SIZE
  };
}
