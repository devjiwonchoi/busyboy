/**
 * What a task lead move tells the orchestrator while it runs. One per server:
 * the move, the message dispatch and the turn start read the same instance.
 *
 * - held: new turns on the thread queue as held until the move ends.
 * - fresh session: the transcript did not reach the new place, so the next
 *   turn starts a new provider session with a summary of the thread.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface LeadMoveGateShape {
  readonly hold: (threadId: ThreadId) => void;
  readonly release: (threadId: ThreadId) => void;
  readonly isHeld: (threadId: ThreadId) => boolean;
  readonly requestFreshSession: (threadId: ThreadId) => void;
  /** True once after requestFreshSession; the caller starts the fresh session. */
  readonly takeFreshSession: (threadId: ThreadId) => boolean;
}

export const makeLeadMoveGate = (): LeadMoveGateShape => {
  const held = new Set<ThreadId>();
  const fresh = new Set<ThreadId>();
  return {
    hold: (threadId) => void held.add(threadId),
    release: (threadId) => void held.delete(threadId),
    isHeld: (threadId) => held.has(threadId),
    requestFreshSession: (threadId) => void fresh.add(threadId),
    takeFreshSession: (threadId) => fresh.delete(threadId),
  };
};

export class LeadMoveGate extends Context.Reference<LeadMoveGateShape>(
  "t3/cloudLead/LeadMoveGate",
  { defaultValue: makeLeadMoveGate },
) {}
