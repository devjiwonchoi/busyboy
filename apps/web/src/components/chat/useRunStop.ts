import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How long a stop asked for during startup waits for the run to appear once
 * the send itself has settled. The send can settle a moment before the server
 * projection reports the run.
 */
export const RUN_STOP_GRACE_MS = 3000;

export type RunStopInput = {
  /** The thread a stop would hit; switching threads drops a held stop. */
  readonly threadKey: string | null;
  /** The server reports a run that `interrupt` can settle. */
  readonly canInterrupt: boolean;
  /** A turn was requested but the server has no interruptible run yet. */
  readonly isStarting: boolean;
  readonly interrupt: () => void;
};

/**
 * Stop works from the moment a turn is requested. Before the server has a run
 * to interrupt, the stop is held and sent as soon as the run shows up.
 */
export function useRunStop(input: RunStopInput) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const [heldThreadKey, setHeldThreadKey] = useState<string | null>(null);
  const isHeld = heldThreadKey !== null && heldThreadKey === input.threadKey;

  const requestStop = () => {
    const current = latest.current;
    if (current.canInterrupt) {
      setHeldThreadKey(null);
      current.interrupt();
      return;
    }
    if (current.isStarting && current.threadKey !== null) {
      setHeldThreadKey(current.threadKey);
    }
  };

  useEffect(() => {
    if (!isHeld) return;
    if (input.canInterrupt) {
      setHeldThreadKey(null);
      latest.current.interrupt();
      return;
    }
    if (input.isStarting) return;
    // The send settled without a run yet; give the projection a moment.
    const timeout = window.setTimeout(() => setHeldThreadKey(null), RUN_STOP_GRACE_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [isHeld, input.canInterrupt, input.isStarting]);

  return {
    /** Stop (button or Escape) is available. */
    canStop: input.canInterrupt || input.isStarting || isHeld,
    /** A stop is held until the starting run can be interrupted. */
    stopPending: isHeld,
    requestStop,
  };
}
