import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { liveTaskChildren } from "./taskChildren.ts";

const shell = (
  id: string,
  launchedBy: string | null,
  state: "running" | "waiting" | "idle" | "archived" = "running",
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    launchedByThreadId: launchedBy === null ? null : ThreadId.make(launchedBy),
    activeRunId: state === "running" || state === "archived" ? `run-${id}` : null,
    pendingRuntimeRequest: state === "waiting" ? { id: "request" } : null,
    archivedAt: state === "archived" ? "2026-11-10T00:00:00Z" : null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

describe("liveTaskChildren", () => {
  it("lists a lead's working children and grandchildren, not finished ones or other tasks'", () => {
    const shells = [
      shell("lead", "pm"),
      shell("implement", "lead"),
      shell("review", "lead", "idle"),
      shell("helper", "implement", "waiting"),
      shell("helper-done", "implement", "idle"),
      shell("old", "lead", "archived"),
      shell("other-lead", "pm"),
      shell("other-child", "other-lead"),
    ];
    expect(liveTaskChildren(shells, ThreadId.make("lead")).map((child) => child.id)).toEqual([
      "implement",
      "helper",
    ]);
  });
});
