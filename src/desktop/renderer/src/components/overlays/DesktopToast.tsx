/** 全局轻量通知。 */
import { IconButton } from "@astryxdesign/core/IconButton";
import { Toast, ToastViewport } from "@astryxdesign/core/Toast";
import { Icon } from "../Icon.js";

export function DesktopToast({ message, onClose }: { message?: string; onClose(): void }): React.JSX.Element | null {
  return message ? (
    <ToastViewport inset={{ bottom: 16, end: 16 }} maxVisible={1} position="bottomEnd">
      <Toast
        autoHideDuration={1_800}
        body={message}
        endContent={<IconButton icon={<Icon name="close" size={12} />} label="关闭通知" onClick={onClose} size="sm" variant="ghost" />}
        isAutoHide
        key={message}
        onDismiss={onClose}
        type="info"
      />
    </ToastViewport>
  ) : null;
}
