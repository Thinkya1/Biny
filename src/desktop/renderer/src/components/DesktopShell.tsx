/**
 * Desktop 最外层产品框架。
 *
 * 这里保留 Astryx Theme，供设置与文件检查器等复用组件继续获取主题上下文；产品外壳本身
 * 只负责组合侧栏、首页、对话区和全局浮层，避免 UI 框架的默认导航结构改变真实业务状态流。
 */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { clampSidebarResizeWidth, clampSidebarWidth, SIDEBAR_RAIL_WIDTH } from "../../../sidebarSizing.js";
import type { SidebarPeekState } from "../app/useSidebarPeek.js";
import type { DesktopThemePreference } from "../../../protocol.js";

interface DesktopShellProps {
  children: React.ReactNode;
  overlays?: React.ReactNode;
  sideNav: React.ReactNode;
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarRailMode: boolean;
  sidebarResizing: boolean;
  sidebarPeekState: SidebarPeekState;
  theme: DesktopThemePreference;
}

/**
 * Peek 固定展开时的流内占位。
 *
 * 始终留在 flex 流中，只有 pinning 状态把它从 0 宽切到目标宽；这样 spacer 和
 * toolbar 在同一个状态提交中启动过渡，固定抽屉切回普通布局时也不会重复推拉主区。
 */
function SidebarPinSpacer({ width, active }: { width: number; active: boolean }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="cindy-sidebar-pin-spacer"
      style={{ flexBasis: active ? width : 0, width: active ? width : 0 }}
    />
  );
}

export function DesktopShell({ children, overlays, sideNav, sidebarVisible, sidebarWidth, sidebarRailMode, sidebarResizing, sidebarPeekState, theme }: DesktopShellProps): React.JSX.Element {
  const resolvedSidebarWidth = sidebarResizing
    ? clampSidebarResizeWidth(sidebarWidth)
    : sidebarRailMode
      ? SIDEBAR_RAIL_WIDTH
      : clampSidebarWidth(sidebarWidth);
  return (
    <Theme mode={theme} theme={neutralTheme}>
      <div
        className="desktop-root cindy-root"
        data-sidebar-collapsed={sidebarVisible ? undefined : "true"}
        data-sidebar-compact={sidebarVisible && sidebarRailMode ? "true" : undefined}
        data-sidebar-pinning={sidebarPeekState === "pinning" ? "true" : undefined}
        data-sidebar-resizing={sidebarResizing ? "true" : undefined}
      >
        <div className="cindy-app-shell">
          <main className="cindy-content-shell">{children}</main>
          <div className="cindy-sidebar-block">
            <SidebarPinSpacer active={sidebarPeekState === "pinning"} width={clampSidebarWidth(sidebarWidth)} />
            {sideNav}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="cindy-sidebar-divider"
          style={{ left: `${sidebarVisible ? resolvedSidebarWidth : 0}px` }}
        />
        {overlays}
      </div>
    </Theme>
  );
}
