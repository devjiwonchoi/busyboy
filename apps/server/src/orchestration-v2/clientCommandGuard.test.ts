import { CommandId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { clientCommandRefusal } from "./clientCommandGuard.ts";

const base = {
  type: "thread.metadata.update" as const,
  commandId: CommandId.make("command:guard"),
  threadId: ThreadId.make("thread:guard"),
};

describe("clientCommandRefusal", () => {
  it("refuses a client changing where a thread runs", () => {
    assert.match(clientCommandRefusal({ ...base, location: "cloud" }) ?? "", /projectTeam\.moveTask/);
  });

  it("allows other metadata updates", () => {
    assert.isNull(clientCommandRefusal({ ...base, title: "Renamed" }));
  });
});
