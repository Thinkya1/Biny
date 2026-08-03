/**
 * Desktop 最外层产品框架。
 *
 * 这里保留 Astryx Theme，供设置与文件检查器等复用组件继续获取主题上下文；产品外壳本身
 * 只负责组合侧栏、首页、对话区和全局浮层，避免 UI 框架的默认导航结构改变真实业务状态流。
 */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { isCompactSidebarWidth } from "../../../sidebarSizing.js";
import type { DesktopThemePreference } from "../../../protocol.js";

interface DesktopShellProps {
  children: React.ReactNode;
  overlays?: React.ReactNode;
  sideNav: React.ReactNode;
  sidebarVisible: boolean;
  sidebarWidth: number;
  theme: DesktopThemePreference;
}

export function DesktopShell({ children, overlays, sideNav, sidebarVisible, sidebarWidth, theme }: DesktopShellProps): React.JSX.Element {
  return (
    <Theme mode={theme} theme={neutralTheme}>
      <div
        className="desktop-root cindy-root"
        data-sidebar-collapsed={sidebarVisible ? undefined : "true"}
        data-sidebar-compact={sidebarVisible && isCompactSidebarWidth(sidebarWidth) ? "true" : undefined}
      >
        <div className="cindy-app-shell">
          <main className="cindy-content-shell">{children}</main>
          {sideNav}
        </div>
        {overlays}
      </div>
    </Theme>
  );
}
