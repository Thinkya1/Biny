/** Slash command 的结构化结果浮层。 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { DesktopSlashResult } from "../../../../protocol.js";

export function SlashResultOverlay({
  result,
  onClose
}: {
  result?: DesktopSlashResult;
  onClose(): void;
}): React.JSX.Element | null {
  // Dialog 退场期间 result 已被清空，保留上一次内容直到组件完成关闭。
  const [lastResult, setLastResult] = useState<DesktopSlashResult>();
  useEffect(() => {
    if (result) setLastResult(result);
  }, [result]);
  const shown = result ?? lastResult;
  if (!shown) return null;
  return (
    <Dialog isOpen={Boolean(result)} maxHeight="min(720px, calc(100vh - 64px))" onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} padding={0} purpose="info" width="min(760px, calc(100vw - 48px))">
      <section className="slash-result-modal">
        <DialogHeader hasDivider onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} subtitle={shown.command} title={shown.title} />
        <div className="desktop-dialog-content"><pre>{shown.content}</pre></div>
      </section>
    </Dialog>
  );
}
