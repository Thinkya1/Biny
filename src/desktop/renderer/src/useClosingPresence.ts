import { useEffect, useState } from "react";

export type PresencePhase = "closed" | "opening" | "open" | "closing";

export function useClosingPresence(open: boolean, closeMs = 150): { present: boolean; phase: PresencePhase } {
  const [present, setPresent] = useState(open);
  const [phase, setPhase] = useState<PresencePhase>(open ? "opening" : "closed");

  useEffect(() => {
    let animationFrame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setPresent(true);
      setPhase("opening");
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
