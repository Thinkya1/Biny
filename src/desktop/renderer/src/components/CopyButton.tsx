import { useState } from "react";
import { copyToClipboard } from "../copyToClipboard.js";
import { Icon } from "./Icon.js";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  size?: number;
  resolveValue?: () => string;
}

export function CopyButton({
  value,
  label = "复制",
  className = "copy-button",
  size = 12,
  resolveValue
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={copied ? "已复制" : label}
      className={className}
      onClick={() => {
        const text = (resolveValue?.() ?? value).replace(/\n$/, "");
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_200);
        });
      }}
      title={copied ? "已复制" : label}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
    </button>
  );
}
