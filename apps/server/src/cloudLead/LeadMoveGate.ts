/**
 * What a task lead move tells the orchestrator while it runs. One per server:
 * the move, the message dispatch and the turn start read the same instance.
 *
 * - held: new turns on the thread queue as held until every hold ends. A move
 *   and a sandbox rotation hold separately, so one never ends the other's.
 * - fresh session: the transcript did not reach the new place, so the next
 *   turn starts a new provider session with a summary of the thread.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export type LeadHoldReason = "move" | "rotation";

export interface LeadMoveGateShape {
  readonly hold: (threadId: ThreadId, reason: LeadHoldReason) => void;
  readonly release: (threadId: ThreadId, reason: LeadHoldReason) => void;
  /** Held for any reason. */
  readonly isHeld: (threadId: ThreadId) => boolean;
  readonly isHeldFor: (threadId: ThreadId, reason: LeadHoldReason) => boolean;
  readonly requestFreshSession: (threadId: ThreadId) => void;
  /** True once after requestFreshSession; the caller starts the fresh session. */
  readonly takeFreshSession: (threadId: ThreadId) => boolean;
}

export const makeLeadMoveGate = (): LeadMoveGateShape => {
  const held = new Set<string>();
  const key = (threadId: ThreadId, reason: LeadHoldReason) => `${reason}:${threadId}`;
  const fresh = new Set<ThreadId>();
  return {
    hold: (threadId, reason) => void held.add(key(threadId, reason)),
    release: (threadId, reason) => void held.delete(key(threadId, reason)),
    isHeld: (threadId) => held.has(key(threadId, "move")) || held.has(key(threadId, "rotation")),
    isHeldFor: (threadId, reason) => held.has(key(threadId, reason)),
    requestFreshSession: (threadId) => void fresh.add(threadId),
    takeFreshSession: (threadId) => fresh.delete(threadId),
  };
};

export class LeadMoveGate extends Context.Reference<LeadMoveGateShape>(
  "t3/cloudLead/LeadMoveGate",
  { defaultValue: makeLeadMoveGate },
) {}
