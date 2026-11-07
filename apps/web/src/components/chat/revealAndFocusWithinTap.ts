import { flushSync } from "react-dom";

/**
 * Shows a hidden composer and focuses it inside the current tap. iOS Safari
 * only focuses an editor (and raises the keyboard) when focus() runs inside
 * the tap's handler; a focus scheduled for a later frame is ignored, so the
 * user would have to tap again.
 */
export function revealAndFocusWithinTap(reveal: () => void, focus: () => void): void {
  // Commit the reveal now: a display:none editor can't take focus.
  flushSync(reveal);
  focus();
}
