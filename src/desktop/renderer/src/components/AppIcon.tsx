import appIconUrl from "../assets/app-icon.png";

export function AppIcon({ size, className }: { size: number; className?: string }): React.JSX.Element {
  return <img alt="" className={`app-icon${className ? ` ${className}` : ""}`} draggable={false} height={size} src={appIconUrl} width={size} />;
}
