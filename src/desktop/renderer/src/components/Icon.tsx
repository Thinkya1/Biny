import type { SVGProps } from "react";

export type IconName =
  | "add"
  | "archive"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "branch"
  | "brain"
  | "check"
  | "chevron"
  | "close"
  | "code"
  | "copy"
  | "diff"
  | "edit"
  | "external"
  | "file"
  | "folder"
  | "folder-panel"
  | "help"
  | "home"
  | "menu"
  | "more"
  | "paperclip"
  | "panel-right"
  | "pin"
  | "person"
  | "plug"
  | "pull-request"
  | "refresh"
  | "search"
  | "sidebar"
  | "settings"
  | "site"
  | "spark"
  | "stop"
  | "terminal"
  | "timer"
  | "trash"
  | "warning"
  | "wand"
  | "wrench";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {pathFor(name)}
    </svg>
  );
}

export function BinyMark({ size = 30 }: { size?: number }): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="biny-mark" height={size} viewBox="0 0 32 32" width={size}>
      <rect fill="currentColor" height="30" rx="9" width="30" x="1" y="1" />
      <path d="M10 8.5h6.7c4 0 6.4 1.8 6.4 4.8 0 1.8-.9 3.2-2.6 4 2.2.7 3.4 2.2 3.4 4.4 0 3.4-2.8 5.8-7.2 5.8H10a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Zm3.2 3v4.3h3.3c1.8 0 2.8-.8 2.8-2.2 0-1.4-1-2.1-3-2.1h-3.1Zm0 7.2v5.8h3.7c2.1 0 3.2-1 3.2-2.9 0-1.9-1.2-2.9-3.6-2.9h-3.3Z" fill="var(--mark-ink)" />
    </svg>
  );
}

function pathFor(name: IconName): React.JSX.Element {
  const common = { stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.7 };
  switch (name) {
    case "add": return <path {...common} d="M12 5v14M5 12h14" />;
    case "archive": return <><rect {...common} height="14" rx="1.5" width="17" x="3.5" y="6.5" /><path {...common} d="M3.5 9h17M9 13h6" /></>;
    case "arrow-left": return <path {...common} d="M19 12H5m7-7-7 7 7 7" />;
    case "arrow-right": return <path {...common} d="M5 12h14m-7-7 7 7-7 7" />;
    case "arrow-up": return <path {...common} d="m6 11 6-6 6 6M12 5v14" />;
    case "branch": return <><circle {...common} cx="7" cy="5" r="2" /><circle {...common} cx="17" cy="19" r="2" /><path {...common} d="M7 7v5c0 3.9 3.1 7 7 7h1M17 5v4c0 2.2-1.8 4-4 4H7" /></>;
    case "brain": return <><path {...common} d="M9.5 5.2A3 3 0 0 0 6 7.8a3.2 3.2 0 0 0 .2 5.9A3 3 0 0 0 9 18.5c.8 1.2 2.2 2 3 2V5.1a3.5 3.5 0 0 0-2.5.1Z" /><path {...common} d="M14.5 5.2A3 3 0 0 1 18 7.8a3.2 3.2 0 0 1-.2 5.9 3 3 0 0 1-2.8 4.8c-.8 1.2-2.2 2-3 2V5.1a3.5 3.5 0 0 1 2.5.1ZM7 9.5h2M15 9.5h2M7.5 14h2M14.5 14h2" /></>;
    case "check": return <path {...common} d="m5 12 4.2 4.2L19 6.5" />;
    case "chevron": return <path {...common} d="m8 10 4 4 4-4" />;
    case "close": return <path {...common} d="m6 6 12 12M18 6 6 18" />;
    case "code": return <path {...common} d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M14 5l-4 14" />;
    case "copy": return <><rect {...common} height="12" rx="2" width="12" x="8" y="8" /><path {...common} d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>;
    case "diff": return <><path {...common} d="M7 4v16M17 4v16M4 8h6M14 16h6" /><path {...common} d="m17 6 2 2-2 2M17 14l-2 2 2 2" /></>;
    case "edit": return <path {...common} d="m4 16.5-.8 3.8 3.8-.8L18.8 7.7a2.1 2.1 0 0 0-3-3L4 16.5ZM14.5 6.5l3 3" />;
    case "external": return <><path {...common} d="M14 5h5v5M19 5l-8 8" /><path {...common} d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>;
    case "file": return <path {...common} d="M7 3.5h6l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm6 0v4h4" />;
    case "folder": return <path {...common} d="M3.5 7.5h6l2-2h9v13a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />;
    case "folder-panel": return <><path {...common} d="M7.5 5h4l2 2H19a1.5 1.5 0 0 1 1.5 1.5V16" /><path {...common} d="M3.5 9h6l2-2h7v11.5A1.5 1.5 0 0 1 17 20H5a1.5 1.5 0 0 1-1.5-1.5V9Z" /></>;
    case "help": return <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M9.8 9a2.3 2.3 0 0 1 4.5.7c0 1.8-2.3 2-2.3 3.8M12 17.4h.01" /></>;
    case "home": return <path {...common} d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9Z" />;
    case "menu": return <path {...common} d="M5 7h14M5 12h14M5 17h14" />;
    case "more": return <><circle cx="6" cy="12" fill="currentColor" r="1.2" /><circle cx="12" cy="12" fill="currentColor" r="1.2" /><circle cx="18" cy="12" fill="currentColor" r="1.2" /></>;
    case "paperclip": return <path {...common} d="m9 12.5 5.9-5.9a3 3 0 0 1 4.2 4.2l-7.4 7.4a5 5 0 0 1-7.1-7.1l7.2-7.2M7.5 14l6.4-6.4" />;
    case "panel-right": return <><rect {...common} height="16" rx="2" width="19" x="2.5" y="4" /><path {...common} d="M16 4v16" /></>;
    case "pin": return <><path {...common} d="m15 4 5 5-3 1-3.5 3.5 2 2-1.5 1.5-3.5-3.5-4 4" /><path {...common} d="m5 19 4-4" /></>;
    case "person": return <><circle {...common} cx="12" cy="8" r="3.2" /><path {...common} d="M5.5 20c.6-4.1 2.8-6.2 6.5-6.2s5.9 2.1 6.5 6.2" /></>;
    case "plug": return <path {...common} d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-5 5.9V21h-2v-5.1A6 6 0 0 1 6 10V8Z" />;
    case "pull-request": return <><circle {...common} cx="7" cy="5" r="2" /><circle {...common} cx="7" cy="19" r="2" /><circle {...common} cx="17" cy="19" r="2" /><path {...common} d="M7 7v10M14 5h1a2 2 0 0 1 2 2v10M14 2l-3 3 3 3" /></>;
    case "refresh": return <><path {...common} d="M20 11a8 8 0 1 0 1 4" /><path {...common} d="M20 5v6h-6" /></>;
    case "search": return <><circle {...common} cx="10.5" cy="10.5" r="6.5" /><path {...common} d="m15.5 15.5 4 4" /></>;
    case "sidebar": return <><rect {...common} height="16" rx="2" width="19" x="2.5" y="4" /><path {...common} d="M8 4v16" /></>;
    case "settings": return <><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>;
    case "site": return <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3.5 12h17M12 3c2.4 2.5 3.5 5.5 3.5 9S14.4 18.5 12 21c-2.4-2.5-3.5-5.5-3.5-9S9.6 5.5 12 3Z" /></>;
    case "spark": return <path {...common} d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Zm6 13 .6 2.4L21 19l-2.4.6L18 22l-.6-2.4L15 19l2.4-.6L18 16Z" />;
    case "stop": return <rect fill="currentColor" height="9" rx="2" width="9" x="7.5" y="7.5" />;
    case "terminal": return <><rect {...common} height="16" rx="2" width="19" x="2.5" y="4" /><path {...common} d="m6 9 3 3-3 3M12 15h5" /></>;
    case "timer": return <><circle {...common} cx="12" cy="13" r="8" /><path {...common} d="M9 2h6M12 5V2M12 13l3-3" /></>;
    case "trash": return <><path {...common} d="M5 7h14M10 4h4l1 3H9l1-3ZM8 7l.7 13h6.6L16 7M10 10v7M14 10v7" /></>;
    case "warning": return <><path {...common} d="M11 4.5 3.7 18a1 1 0 0 0 .9 1.5h14.8a1 1 0 0 0 .9-1.5L13 4.5a1.1 1.1 0 0 0-2 0Z" /><path {...common} d="M12 9v4M12 16.5h.01" /></>;
    case "wand": return <><path {...common} d="m5 19 10.5-10.5M7 5h.01M17 4h.01M19 9h.01M5 12h.01M17 16h.01" /><path {...common} d="m15.5 3.5.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>;
    case "wrench": return <path {...common} d="M14.5 6.2a4.5 4.5 0 0 0-5.8 5.7l-5.1 5.2a1.8 1.8 0 0 0 2.5 2.5l5.2-5.1a4.5 4.5 0 0 0 5.7-5.8l-3 3-2.5-.7-.7-2.5 3-3Z" />;
  }
}
