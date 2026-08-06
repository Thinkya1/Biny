/** Composer 的发送/停止状态切换。 */
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";

export function SendOrStopButton({
  disabled,
  disabledReason,
  onSend,
  onStop,
  running,
  stopPending
}: {
  disabled: boolean;
  disabledReason?: string;
  onSend(): void;
  onStop(): void;
  running: boolean;
  stopPending: boolean;
}): React.JSX.Element {
  const isDisabled = running ? stopPending : disabled;
  const label = running ? stopPending ? "正在停止" : "停止生成" : "发送消息";
  const tooltip = running
    ? stopPending ? "正在停止当前运行…" : "停止当前运行"
    : disabledReason ?? (disabled ? "输入内容或附件后发送消息" : "发送消息");

  return (
    <span className={`cindy-send-button-anchor${stopPending ? " is-pending" : ""}`} aria-busy={stopPending || undefined}>
      <ComposerActionButton
        active={running}
        className={`cindy-send-button${running ? " is-stop" : ""}`}
        disabled={isDisabled}
        disabledReason={running && stopPending ? "正在停止当前运行…" : !running && disabled ? disabledReason ?? "输入内容或附件后发送消息" : undefined}
        label={label}
        loading={stopPending}
        onClick={running ? onStop : onSend}
        tooltip={tooltip}
      >
        <Icon name={running ? "stop" : "arrow-up"} size={15} />
      </ComposerActionButton>
    </span>
  );
}
