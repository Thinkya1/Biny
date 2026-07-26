/**
 * 带退场动画的挂载状态。
 *
 * 直接按 `open` 卸载节点会让关闭动画来不及播放，所以这里把「是否挂载」和「当前动画阶段」
 * 拆开：关闭时先进入 closing，等 `closeMs` 后才真正卸载。
 */
import { useEffect, useState } from "react";

export type PresencePhase = "closed" | "opening" | "open" | "closing";

/** `present` 决定是否渲染节点，`phase` 供 CSS 选择对应的过渡样式。 */
export function useClosingPresence(open: boolean, closeMs = 150): { present: boolean; phase: PresencePhase } {
  const [present, setPresent] = useState(open);
  const [phase, setPhase] = useState<PresencePhase>(open ? "opening" : "closed");

  useEffect(() => {
    let animationFrame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setPresent(true);
      setPhase("opening");
      // 先挂载在 opening 初态，下一帧再切到 open，否则浏览器不会插值出入场过渡。
      animationFrame = window.requestAnimationFrame(() => setPhase("open"));
    } else if (present) {
      setPhase("closing");
      timer = setTimeout(() => {
        setPresent(false);
        setPhase("closed");
      }, closeMs);
    }
    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      if (timer) clearTimeout(timer);
    };
  }, [closeMs, open, present]);

  return { present, phase };
}
