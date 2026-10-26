import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCommandPaletteOpen } from "../../commandPaletteBus";

/** How long the first Escape waits for the second before it lapses. */
export const ESCAPE_TO_STOP_WINDOW_MS = 1500;

// Escape inside an open overlay closes that overlay, never the turn.
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export type EscapeToStopInput = {
  readonly canStop: boolean;
  /** The thread a stop would hit; switching threads drops a pending first press. */
  readonly threadKey: string | null;
  /** True when Escape belongs to another surface, such as a focused terminal. */
  readonly ignoreEscape: (event: KeyboardEvent) => boolean;
  readonly onStop: () => void;
};

/**
 * Pressing Escape twice stops the running turn. The first press arms it so the
 * caller can show a hint; a second press inside the window stops. Escape that
 * another control already handled (default prevented) never counts.
 */
export function useEscapeToStop(input: EscapeToStopInput) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const [isArmed, setIsArmed] = useState(false);
  const isArmedRef = useRef(false);
  const setArmed = (armed: boolean) => {
    isArmedRef.current = armed;
    setIsArmed(armed);
  };

  // Listen in the bubble phase so menus and editors see Escape first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      if (
        event.key !== "Escape" ||
        event.repeat ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !current.canStop ||
        isCommandPaletteOpen() ||
        current.ignoreEscape(event)
      ) {
        return;
      }
      if (event.target instanceof Element && event.target.closest(OVERLAY_SELECTOR)) {
        return;
      }

      event.preventDefault();
      if (!isArmedRef.current) {
        setArmed(true);
        return;
      }
      setArmed(false);
      current.onStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // A first press lapses after the window, when the turn ends, or on thread switch.
  useEffect(() => {
    if (!isArmed) {
      return;
    }
    const timeout = window.setTimeout(() => setArmed(false), ESCAPE_TO_STOP_WINDOW_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [isArmed]);
  useEffect(() => {
    setArmed(false);
  }, [input.canStop, input.threadKey]);

  return isArmed && input.canStop;
}
