export type SelectionActionPoint = { x: number; y: number };

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;
/** How long a touch selection must hold still (handles released) before its actions show. */
export const TOUCH_SELECTION_SETTLE_MS = 300;
/**
 * Gap between a touch selection's last line and its actions: clears the end handle's knob. The
 * phone's own copy menu sits above the selection, so ours goes below.
 */
export const TOUCH_SELECTION_ACTION_GAP = 28;

export type SelectionInput = "mouse" | "touch";

export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { left?: number; right: number; bottom: number } | null;
  pointer: SelectionActionPoint | null;
  viewport: { width: number; height: number };
  input?: SelectionInput;
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport, input = "mouse" } = options;
  const preferred =
    input === "touch" && selectionRect
      ? {
          x: selectionRect.left ?? selectionRect.right,
          y: selectionRect.bottom + TOUCH_SELECTION_ACTION_GAP,
        }
      : (pointer ?? {
          x: selectionRect?.right ?? bounds.left + bounds.width - 140,
          y: selectionRect ? selectionRect.bottom + 4 : bounds.top + 12,
        });
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8),
    ),
    y: Math.max(
      8,
      Math.min(
        Math.max(bounds.top, preferred.y),
        // Below the box is fine on touch: the actions must clear the end handle.
        input === "touch" ? Infinity : bounds.top + bounds.height,
        viewport.height - 8,
      ),
    ),
  };
}

/**
 * Mouse selections show their actions on release. Touch selections (long-press, then dragging the
 * handles) never send mouseup and the browser cancels the touch (pointercancel on iOS,
 * contextmenu on Android), so they show once selectionchange settles instead.
 *
 * Interactive popovers pass getActionElement to keep editing their fields from replacing the
 * captured source selection.
 */
export function observeSelectionActions({
  element,
  getActionElement,
  onSelection,
  onDismiss,
}: {
  element: HTMLElement;
  getActionElement?: () => HTMLElement | null;
  onSelection: (pointer: SelectionActionPoint | null, input: SelectionInput) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let pointer: SelectionActionPoint | null = null;
  let input: SelectionInput = "mouse";
  // A press on the actions: the phone may clear the selection before the tap lands.
  let actionHeld = false;
  let timer: number | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target !== null && (getActionElement?.()?.contains(target as Node) ?? false);

  const cancelPending = () => {
    if (timer !== null) view.clearTimeout(timer);
    if (frame !== null) view.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const onContextMenu = () => {
    // Android long-press opens a context menu event, then selects the word.
    if (input === "touch") return;
    cancel();
    onDismiss("interaction");
  };
  const schedule = (delay: number) => {
    cancelPending();
    timer = view.setTimeout(() => {
      timer = null;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer, input);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    input = event.pointerType === "mouse" ? "mouse" : "touch";
    actionHeld = isActionTarget(event.target);
    if (actionHeld) {
      cancel();
      return;
    }
    cancelPending();
    // A touch never sends a matching mouseup after a long-press.
    pointerDown = input === "mouse" && event.button === 0;
    const inside = element.contains(event.target as Node);
    gestureActive = false;
    dismissed = true;
    pointer = null;
    if (inside) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };
  const onSelectionStart = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType !== "mouse") return;
    const target = event.target as Element | null;
    if (target?.closest("button, [role=button]")) return;
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    // Preventing pointerdown (for example on a toolbar) can suppress mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };
  const onPointerCancel = (event: PointerEvent) => {
    // iOS cancels the touch when a long-press turns into a text selection.
    if (event.pointerType !== "mouse") return;
    dismiss();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    input = "mouse";
    actionHeld = false;
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      dismissed = true;
    }
    onDismiss("cancel");
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("mouseup", onMouseUp);
  view.addEventListener("pointercancel", onPointerCancel);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", onContextMenu, true);
  element.addEventListener("scroll", onScroll, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    get pending() {
      return timer !== null || frame !== null;
    },
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (input === "touch") {
        if (actionHeld) return;
        // Each handle move restarts the wait; the actions hide while the selection moves.
        onDismiss("cancel");
        pointer = null;
        dismissed = false;
        schedule(TOUCH_SELECTION_SETTLE_MS);
      } else if (pointerDown || gestureActive) {
        onDismiss("cancel");
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp);
      view.removeEventListener("mouseup", onMouseUp);
      view.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", onContextMenu, true);
      element.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}
