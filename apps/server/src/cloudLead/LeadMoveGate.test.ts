import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { makeLeadMoveGate } from "./LeadMoveGate.ts";

const lead = ThreadId.make("thread:lead");

describe("LeadMoveGate", () => {
  it("keeps a lead held until both a move and a sandbox rotation let go", () => {
    const gate = makeLeadMoveGate();
    gate.hold(lead, "rotation");
    gate.hold(lead, "move");

    // The rotation finishes first: the move still holds the lead.
    gate.release(lead, "rotation");
    assert.isTrue(gate.isHeld(lead));
    assert.isTrue(gate.isHeldFor(lead, "move"));

    gate.release(lead, "move");
    assert.isFalse(gate.isHeld(lead));
  });

  it("starts a fresh session once per request", () => {
    const gate = makeLeadMoveGate();
    gate.requestFreshSession(lead);
    assert.isTrue(gate.takeFreshSession(lead));
    assert.isFalse(gate.takeFreshSession(lead));
  });
});
