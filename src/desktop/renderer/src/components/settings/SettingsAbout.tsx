/** About 页只展示真实构建版本。 */
import { AppIcon } from "../AppIcon.js";

export function SettingsAbout({ version }: { version: string }): React.JSX.Element {
  return <div className="about-settings"><AppIcon className="about-mark" size={66} /><h3>Biny</h3><p>版本 {version}</p><p>基于现有 Biny Agent 核心的 macOS 桌面交互层。</p></div>;
}
