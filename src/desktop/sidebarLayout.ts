/**
 * 桌面端侧栏的状态和几何约束。
 *
 * 侧栏的普通宽度、rail 预览宽度和收起/peek 是不同维度：拖拽时只改变临时
 * previewWidth，松手后才提交 expandedWidth。这样渲染层不需要用多个 boolean
 * 猜测当前布局，也不会把 rail 的视觉宽度写成下一次启动的普通宽度。
 */
import {
  clampSidebarResizeWidth,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  isCompactSidebarWidth,
  MIN_SIDEBAR_WIDTH,
  normalizeSidebarWidth,
  SIDEBAR_RAIL_WIDTH
} from "./sidebarSizing.js";

export type SidebarBaseMode = "expanded" | "rail" | "collapsed";
export type SidebarMode = SidebarBaseMode | "peek";
export type SidebarPeekPhase = "idle" | "peeking" | "peekClosing" | "peekExited" | "pinning";
export type SidebarTransition = "idle" | "peek-closing" | "peek-exited" | "pinning";

export interface SidebarLayoutSnapshot {
  mode: SidebarMode;
  visualWidth: number;
  flowWidth: number;
  contentWidth: number;
  expandedWidth: number;
  resizing: boolean;
  transition: SidebarTransition;
}

export interface SidebarLayoutState {
  baseMode: SidebarBaseMode;
  expandedWidth: number;
  previewWidth?: number;
  resizing: boolean;
  peekPhase: SidebarPeekPhase;
}

export interface SidebarResizePreview {
  mode: "expanded" | "rail";
  width: number;
}

export interface SidebarResizeStart {
  startX: number;
  startWidth: number;
  expandedWidth: number;
}

export interface SidebarKeyboardAdjustment {
  mode: SidebarBaseMode;
  expandedWidth: number;
  persistRail: boolean;
  persistWidth?: number;
}

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayoutState = {
  baseMode: "expanded",
  expandedWidth: DEFAULT_SIDEBAR_WIDTH,
  resizing: false,
  peekPhase: "idle"
};

/** 把普通展开宽度归一化为可以持久化的值。 */
export function normalizeSidebarExpandedWidth(width: number): number {
  return normalizeSidebarWidth(width);
}

/** 根据当前模式返回开始拖拽时的视觉宽度。 */
export function sidebarResizeStart(input: { baseMode: SidebarBaseMode; expandedWidth: number; startX: number }): SidebarResizeStart {
  return {
    startX: input.startX,
    startWidth: input.baseMode === "rail" ? SIDEBAR_RAIL_WIDTH : clampSidebarWidth(input.expandedWidth),
    expandedWidth: clampSidebarWidth(input.expandedWidth)
  };
}

/** 把指针位置转换成拖拽中的临时宽度和临时模式。 */
export function previewSidebarResize(start: SidebarResizeStart, clientX: number): SidebarResizePreview {
  const rawWidth = start.startWidth + clientX - start.startX;
  const width = clampSidebarResizeWidth(rawWidth);
  return {
    mode: isCompactSidebarWidth(width) ? "rail" : "expanded",
    width
  };
}

/** 松手时提交拖拽结果；进入 rail 不覆盖上一次有效的普通宽度。 */
export function commitSidebarResize(preview: SidebarResizePreview, expandedWidth: number): SidebarKeyboardAdjustment {
  if (preview.mode === "rail") {
    return {
      mode: "rail",
      expandedWidth: clampSidebarWidth(expandedWidth),
      persistRail: true
    };
  }
  return {
    mode: "expanded",
    expandedWidth: clampSidebarWidth(preview.width),
    persistRail: false,
    persistWidth: clampSidebarWidth(preview.width)
  };
}

/** 统一鼠标和键盘的 rail/普通宽度边界。 */
export function adjustSidebarWithKeyboard(input: { mode: SidebarBaseMode; expandedWidth: number; direction: "left" | "right" }): SidebarKeyboardAdjustment {
  const expandedWidth = clampSidebarWidth(input.expandedWidth);
  if (input.mode === "rail") {
    if (input.direction === "left") {
      return { mode: "rail", expandedWidth, persistRail: true };
    }
    return { mode: "expanded", expandedWidth, persistRail: false };
  }
  if (input.mode === "collapsed") return { mode: "collapsed", expandedWidth, persistRail: false };
  if (input.direction === "left" && expandedWidth === MIN_SIDEBAR_WIDTH) {
    return { mode: "rail", expandedWidth, persistRail: true };
  }
  const nextWidth = clampSidebarWidth(expandedWidth + (input.direction === "left" ? -16 : 16));
  return {
    mode: "expanded",
    expandedWidth: nextWidth,
    persistRail: false,
    persistWidth: nextWidth
  };
}

/**
 * 由同一份输入生成 Sidebar 和 DesktopShell 共用的布局快照。
 * peek 是 collapsed 的临时覆盖层；pinning 期间只让 spacer 推动主区，不改变
 * collapsed 基础状态，直到 pin 定时器完成后再切换为 expanded。
 */
export function resolveSidebarLayout(input: SidebarLayoutState): SidebarLayoutSnapshot {
  const expandedWidth = clampSidebarWidth(input.expandedWidth);
  const previewWidth = input.resizing && input.previewWidth !== undefined
    ? clampSidebarResizeWidth(input.previewWidth)
    : undefined;
  const previewMode = previewWidth === undefined
    ? undefined
    : isCompactSidebarWidth(previewWidth) ? "rail" : "expanded";
  const mode: SidebarMode = input.baseMode === "collapsed"
    && input.peekPhase !== "idle"
    && input.peekPhase !== "peekExited"
    ? "peek"
    : previewMode ?? input.baseMode;
  const visualWidth = previewWidth !== undefined
    ? previewWidth
    : mode === "collapsed" ? 0
      : mode === "rail" ? SIDEBAR_RAIL_WIDTH
        : expandedWidth;
  const isPeek = mode === "peek";
  const flowWidth = isPeek
    ? input.peekPhase === "pinning" ? expandedWidth : 0
    : visualWidth;
  // contentWidth 是当前可见内容的实际盒宽，不是用于恢复的普通展开宽度。
  // 拖拽预览时必须和 visualWidth 同步，否则 body 会在外壳收缩后继续溢出，
  // 顶部视觉边界与左侧内容边界就会出现错位；稳定 rail 也只应保留 78px 的盒宽。
  const contentWidth = previewWidth !== undefined
    ? previewWidth
    : mode === "rail" ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const transition: SidebarTransition = input.peekPhase === "pinning"
    ? "pinning"
    : input.peekPhase === "peekClosing"
      ? "peek-closing"
      : input.peekPhase === "peekExited"
        ? "peek-exited"
      : "idle";
  return {
    mode,
    visualWidth,
    flowWidth,
    contentWidth,
    expandedWidth,
    resizing: input.resizing,
    transition
  };
}
