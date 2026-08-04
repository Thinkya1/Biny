/**
 * 收起侧栏后的 Cindy 风格 Peek 生命周期。
 *
 * Peek 是 Renderer 的临时视觉状态，不写入 DesktopStateStore。悬停时侧栏固定在内容上方，
 * 只有用户明确点击收起/展开按钮才进入 pinning；pinning 完成后由调用方把侧栏正式放回流布局。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SIDEBAR_PEEK_CLOSE_MS,
  SIDEBAR_PEEK_LEAVE_GRACE_MS,
  SIDEBAR_PEEK_OPEN_DELAY_MS,
  SIDEBAR_PEEK_PINNING_MS
} from "../../../sidebarSizing.js";

export type SidebarPeekState = "idle" | "peeking" | "peekClosing" | "pinning";

export interface SidebarPeekHandlers {
  onPointerEnter: React.PointerEventHandler<HTMLElement>;
  onPointerLeave: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onPointerUp?: React.PointerEventHandler<HTMLElement>;
}

interface SidebarPeekOptions {
  collapsed: boolean;
  onPin(): void;
}

interface SidebarPeekResult {
  drawerHandlers: SidebarPeekHandlers;
  drawerRef: React.RefObject<HTMLElement | null>;
  pin(): void;
  peekState: SidebarPeekState;
  triggerHandlers: SidebarPeekHandlers;
}

const PEEK_TRIGGER_WIDTH = 12;

export function useSidebarPeek({ collapsed, onPin }: SidebarPeekOptions): SidebarPeekResult {
  const [peekState, setPeekState] = useState<SidebarPeekState>("idle");
  const stateRef = useRef<SidebarPeekState>("idle");
  const drawerRef = useRef<HTMLElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverLockedRef = useRef(false);

  const setState = useCallback((next: SidebarPeekState): void => {
    stateRef.current = next;
    setPeekState(next);
  }, []);

  const clearTimer = useCallback((timerRef: { current: ReturnType<typeof setTimeout> | undefined }): void => {
    if (timerRef.current === undefined) return;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const clearTimers = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    clearTimer(pinTimerRef);
  }, [clearTimer]);

  const closePeek = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (!collapsed || stateRef.current === "idle" || stateRef.current === "pinning") return;
    if (stateRef.current === "peekClosing") return;
    setState("peekClosing");
    closeAnimationTimerRef.current = setTimeout(() => {
      closeAnimationTimerRef.current = undefined;
      if (stateRef.current === "peekClosing") setState("idle");
    }, SIDEBAR_PEEK_CLOSE_MS);
  }, [clearTimer, collapsed, setState]);

  const scheduleClose = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (!collapsed || stateRef.current === "idle" || stateRef.current === "pinning") return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      if (!hoverLockedRef.current) closePeek();
    }, SIDEBAR_PEEK_LEAVE_GRACE_MS);
  }, [clearTimer, closePeek, collapsed]);

  const keepPeekOpen = useCallback((): void => {
    hoverLockedRef.current = true;
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    if (!collapsed || stateRef.current === "pinning") return;
    if (stateRef.current === "peekClosing") setState("peeking");
  }, [clearTimer, collapsed, setState]);

  const scheduleOpen = useCallback((): void => {
    if (!collapsed || stateRef.current === "pinning" || stateRef.current === "peeking") return;
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    if (openTimerRef.current !== undefined) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = undefined;
      if (collapsed && hoverLockedRef.current && stateRef.current === "idle") setState("peeking");
    }, SIDEBAR_PEEK_OPEN_DELAY_MS);
  }, [clearTimer, collapsed, setState]);

  const onPointerEnter = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
    scheduleOpen();
  }, [keepPeekOpen, scheduleOpen]);

  const onPointerLeave = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    hoverLockedRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    hoverLockedRef.current = true;
    clearTimer(closeTimerRef);
  }, [clearTimer]);

  const onPointerUp = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  const pin = useCallback((): void => {
    if (!collapsed) {
      onPin();
      return;
    }
    clearTimers();
    hoverLockedRef.current = true;
    setState("pinning");
    pinTimerRef.current = setTimeout(() => {
      pinTimerRef.current = undefined;
      if (stateRef.current !== "pinning") return;
      onPin();
    }, SIDEBAR_PEEK_PINNING_MS);
  }, [clearTimers, collapsed, onPin, setState]);

  useEffect(() => {
    if (!collapsed) {
      clearTimers();
      hoverLockedRef.current = false;
      if (stateRef.current !== "idle") setState("idle");
      return;
    }
    const handlePointerMove = (event: PointerEvent): void => {
      const target = event.target;
      const element = target instanceof Element ? target : undefined;
      const drawer = drawerRef.current;
      const inDrawer = Boolean(drawer && target instanceof Node && drawer.contains(target));
      const inTrigger = Boolean(element?.closest(".cindy-sidebar-peek-trigger"));
      const inChrome = Boolean(element?.closest(".cindy-sidebar-topbar-floating"));
      if (inDrawer || inTrigger || inChrome || event.clientX <= PEEK_TRIGGER_WIDTH) {
        keepPeekOpen();
        if ((inTrigger || event.clientX <= PEEK_TRIGGER_WIDTH) && stateRef.current === "idle") scheduleOpen();
        return;
      }
      hoverLockedRef.current = false;
      scheduleClose();
    };
    const handleWindowBlur = (): void => {
      hoverLockedRef.current = false;
      clearTimers();
      closePeek();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [clearTimers, closePeek, collapsed, keepPeekOpen, scheduleClose, scheduleOpen, setState]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return {
    drawerHandlers: { onPointerEnter, onPointerLeave, onPointerMove, onPointerDown, onPointerUp },
    drawerRef,
    pin,
    peekState,
    triggerHandlers: { onPointerEnter, onPointerLeave, onPointerMove }
  };
}
