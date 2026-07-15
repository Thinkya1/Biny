import { Icon } from "./Icon.js";

interface NavigationControlsProps {
  sidebarVisible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onToggleSidebar(): void;
  onBack(): void;
  onForward(): void;
}

export function NavigationControls({ sidebarVisible, canGoBack, canGoForward, onToggleSidebar, onBack, onForward }: NavigationControlsProps): React.JSX.Element {
  return (
    <div className="navigation-controls">
      <button aria-label={sidebarVisible ? "收起侧栏" : "展开侧栏"} className="navigation-button" onClick={onToggleSidebar} type="button"><Icon name="sidebar" size={15} /></button>
      <button aria-label="后退" className="navigation-button" disabled={!canGoBack} onClick={onBack} type="button"><Icon name="arrow-left" size={15} /></button>
      <button aria-label="前进" className="navigation-button" disabled={!canGoForward} onClick={onForward} type="button"><Icon name="arrow-right" size={15} /></button>
    </div>
  );
}
