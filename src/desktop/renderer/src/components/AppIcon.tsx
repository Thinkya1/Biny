/**
 * 应用图标。
 *
 * 纯装饰元素：`alt` 留空避免读屏重复播报，`draggable={false}` 防止拖出图片文件。
 */
import appIconUrl from "../assets/app-icon.png";

export function AppIcon({ size, className }: { size: number; className?: string }): React.JSX.Element {
  return <img alt="" className={`app-icon${className ? ` ${className}` : ""}`} draggable={false} height={size} src={appIconUrl} width={size} />;
}
