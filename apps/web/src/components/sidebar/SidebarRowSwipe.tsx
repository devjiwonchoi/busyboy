import { ArchiveIcon, PinIcon, PinOffIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

const ACTION_WIDTH = 64;
// A finger has to travel this far before we decide between a swipe and a scroll.
const DECIDE_DISTANCE = 8;
// Releasing past this share of the row's width archives without a second tap.
const FULL_SWIPE_RATIO = 0.6;

export type SidebarRowSwipeAction = {
  kind: "pin" | "unpin" | "archive";
  onSelect: () => void;
};

const actionStyle = {
  pin: { label: "Pin", Icon: PinIcon, className: "bg-warning text-white" },
  unpin: { label: "Unpin", Icon: PinOffIcon, className: "bg-warning text-white" },
  archive: { label: "Archive", Icon: ArchiveIcon, className: "bg-info text-white" },
} as const;

/**
 * Swipe a row left with a finger to reveal its actions, iOS Mail style. A long
 * swipe runs the archive action. Mouse input is ignored, so a narrow desktop
 * window keeps its hover buttons and drag-to-reorder.
 */
export function SidebarRowSwipe(props: {
  /** Phone layout. The wrapper stays mounted while this holds, so rows don't remount. */
  enabled: boolean;
  /** Pauses the gesture, for example while the title is being renamed. */
  paused?: boolean | undefined;
  actions: readonly SidebarRowSwipeAction[];
  children: ReactNode;
}) {
  const { enabled, actions } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [offset, setOffsetState] = useState(0);
  // Pointer handlers can run several times before React re-renders, so they read this.
  const offsetRef = useRef(0);
  const setOffset = (next: number) => {
    offsetRef.current = next;
    setOffsetState(next);
  };
  const [tracking, setTracking] = useState(false);
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    base: number;
    axis: "x" | "y" | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const archive = actions.find((action) => action.kind === "archive");
  const trayWidth = actions.length * ACTION_WIDTH;
  const active = enabled && !props.paused && actions.length > 0;
  const open = offset < 0;

  useEffect(() => {
    if (!active) setOffset(0);
  }, [active]);

  // Tapping anywhere outside an open row closes it, like Mail.
  useEffect(() => {
    if (!open || tracking) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOffset(0);
    };
    document.addEventListener("pointerdown", close, { capture: true });
    return () => document.removeEventListener("pointerdown", close, { capture: true });
  }, [open, tracking]);

  if (!enabled) return <>{props.children}</>;

  const rowWidth = () => rootRef.current?.getBoundingClientRect().width ?? 320;

  const handlePointerDown = (event: ReactPointerEvent) => {
    if (!active || event.pointerType === "mouse" || !event.isPrimary) return;
    // Keep the drag-to-reorder sensor on the list item from claiming this touch.
    event.stopPropagation();
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: offsetRef.current,
      axis: null,
    };
  };
  const handlePointerMove = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.axis === null) {
      if (Math.abs(dx) < DECIDE_DISTANCE && Math.abs(dy) < DECIDE_DISTANCE) return;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (current.axis === "y") return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone; the swipe still tracks without capture.
      }
      setTracking(true);
    }
    if (current.axis !== "x") return;
    const max = archive ? rowWidth() : trayWidth;
    setOffset(Math.max(-max, Math.min(0, current.base + dx)));
  };
  const finish = (event: ReactPointerEvent, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.axis !== "x") {
      // A plain tap on an open row closes it instead of opening the thread.
      if (current.axis === null && current.base < 0 && !cancelled) {
        suppressClick.current = true;
        setOffset(0);
      }
      return;
    }
    setTracking(false);
    suppressClick.current = true;
    const travelled = -offsetRef.current;
    if (!cancelled && archive && travelled > rowWidth() * FULL_SWIPE_RATIO) {
      setOffset(0);
      archive.onSelect();
      return;
    }
    setOffset(!cancelled && travelled > trayWidth / 2 ? -trayWidth : 0);
  };
  const handleClickCapture = (event: ReactMouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={rootRef}
      data-testid="sidebar-row-swipe"
      data-swipe-open={open || undefined}
      className="relative overflow-hidden rounded-md"
    >
      {open ? (
        <div
          data-testid="sidebar-row-swipe-actions"
          className="absolute inset-y-0 right-0 flex"
          style={{ width: Math.max(trayWidth, -offset) }}
        >
          {actions.map((action) => {
            const style = actionStyle[action.kind];
            return (
              <button
                key={action.kind}
                type="button"
                aria-label={`${style.label} thread`}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 text-2xs font-medium",
                  // Archive fills whatever the swipe uncovers, so a long swipe reads as "archive".
                  action.kind === "archive" ? "flex-1" : "w-16 shrink-0",
                  style.className,
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  setOffset(0);
                  action.onSelect();
                }}
              >
                <style.Icon aria-hidden className="size-4" />
                {style.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className={cn(
          "relative touch-pan-y bg-sidebar",
          !tracking && "transition-transform duration-200 motion-reduce:transition-none",
        )}
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finish(event, false)}
        onPointerCancel={(event) => finish(event, true)}
        onClickCapture={handleClickCapture}
      >
        {props.children}
      </div>
    </div>
  );
}
