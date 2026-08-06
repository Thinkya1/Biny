/**
 * Desktop 最外层产品框架。
 *
 * 这里保留 Astryx Theme，供设置与文件检查器等复用组件继续获取主题上下文；产品外壳本身
 * 只负责组合侧栏、首页、对话区和全局浮层，避免 UI 框架的默认导航结构改变真实业务状态流。
 */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { SidebarLayoutSnapshot } from "../../../sidebarLayout.js";
import type { DesktopThemePreference } from "../../../protocol.js";

interface DesktopShellProps {
  children: React.ReactNode;
  overlays?: React.ReactNode;
  rightPanel?: React.ReactNode;
  sideNav: React.ReactNode;
  sidebarLayout: SidebarLayoutSnapshot;
  theme: DesktopThemePreference;
}

/**
 * Peek 固定展开时的流内占位。
 *
 * 始终留在 flex 流中，只有 pinning 状态把它切到共享的流宽度；这样 spacer 和
 * 侧栏主体使用同一个动画时钟，固定抽屉切回普通布局时也不会重复推拉主区。
 */
function SidebarPinSpacer({ active }: { active: boolean }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="cindy-sidebar-pin-spacer"
      data-active={active ? "true" : undefined}
    />
  );
}

export function DesktopShell({ children, overlays, rightPanel, sideNav, sidebarLayout, theme }: DesktopShellProps): React.JSX.Element {
  const rootStyle = {
    "--cindy-sidebar-visual-width": `${sidebarLayout.visualWidth}px`,
    "--cindy-sidebar-flow-width": `${sidebarLayout.flowWidth}px`,
    "--cindy-sidebar-content-width": `${sidebarLayout.contentWidth}px`,
    "--cindy-sidebar-expanded-width": `${sidebarLayout.expandedWidth}px`
  } as React.CSSProperties;
  return (
    <Theme mode={theme} theme={neutralTheme}>
      <div
        className="desktop-root cindy-root"
        data-sidebar-mode={sidebarLayout.mode}
        data-sidebar-resizing={sidebarLayout.resizing ? "true" : undefined}
        data-sidebar-transition={sidebarLayout.transition === "idle" ? undefined : sidebarLayout.transition}
        style={rootStyle}
      >
        <div className="cindy-app-shell">
          <main className="cindy-content-shell">{children}</main>
          <div className="cindy-sidebar-block">
            <SidebarPinSpacer active={sidebarLayout.transition === "pinning"} />
            {sideNav}
          </div>
          {rightPanel}
        </div>
        <div
          aria-hidden="true"
          className="cindy-sidebar-divider"
        />
        {overlays}
      </div>
    </Theme>
  );
}
