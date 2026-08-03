/**
 * 标题栏左侧的导航按钮组：侧栏开关、后退、前进。
 *
 * 只负责渲染和回调，前进/后退是否可用由上层的导航历史决定。按钮只有图标，因此必须带
 * `aria-label`。
 */
import { IconButton } from "@astryxdesign/core/IconButton";
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
      <IconButton icon={<Icon name="sidebar" size={15} />} label={sidebarVisible ? "收起侧栏" : "展开侧栏"} onClick={onToggleSidebar} size="sm" tooltip={sidebarVisible ? "收起侧栏" : "展开侧栏"} variant="ghost" />
      <IconButton icon={<Icon name="arrow-left" size={15} />} isDisabled={!canGoBack} label="后退" onClick={onBack} size="sm" tooltip="后退" variant="ghost" />
      <IconButton icon={<Icon name="arrow-right" size={15} />} isDisabled={!canGoForward} label="前进" onClick={onForward} size="sm" tooltip="前进" variant="ghost" />
    </div>
  );
}
