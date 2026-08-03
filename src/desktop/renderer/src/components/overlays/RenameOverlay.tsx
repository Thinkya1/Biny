/** 项目与任务共享的重命名对话框。 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { TextInput } from "@astryxdesign/core/TextInput";

export function RenameOverlay({
  open,
  initialValue,
  title = "重命名会话",
  onClose,
  onSave
}: {
  open: boolean;
  initialValue: string;
  title?: string;
  onClose(): void;
  onSave(value: string): Promise<void>;
}): React.JSX.Element | null {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    window.requestAnimationFrame(() => inputRef.current?.select());
  }, [initialValue, open]);
  return (
    <Dialog isOpen={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} padding={0} purpose="form" width={440}>
      <form className="desktop-dialog-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void onSave(value.trim()); }}>
        <DialogHeader hasDivider onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={title} />
        <div className="desktop-dialog-content">
          <TextInput
            hasAutoFocus
            isLabelHidden
            label={title}
            onChange={(nextValue) => setValue(nextValue.slice(0, 120))}
            placeholder="输入新名称…"
            ref={inputRef}
            value={value}
            width="100%"
          />
          <div className="desktop-dialog-actions">
            <Button label="取消" onClick={onClose} type="button" variant="ghost" />
            <Button isDisabled={!value.trim()} label="保存" type="submit" variant="primary" />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
