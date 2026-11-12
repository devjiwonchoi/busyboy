// @effect-diagnostics nodeBuiltinImport:off - writes the timeline into a throwaway nodes home.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { buildStatus } from "./compute.ts";
import { parseRecord, type RecordFiles } from "./parseJwn.ts";
import { observeTimeline, timelinePath } from "./timeline.ts";

let nodesHome: string;
beforeEach(() => {
  nodesHome = mkdtempSync(join(tmpdir(), "node-timeline-"));
});
afterEach(() => {
  rmSync(nodesHome, { recursive: true, force: true });
});

const ALIGN = "# ALIGN: Timeline\n# Success criteria\n## 1 · Works\n## 2 · Fast\n";
const VERIFY = (second: string) =>
  `| Criterion | Result | Evidence |\n| --- | --- | --- |\n| 1 | pass | ok |\n| 2 | ${second} | ok |\n`;

const observe = (files: RecordFiles, now: string) =>
  observeTimeline({
    nodesHome,
    nodeId: "busyboy/timeline",
    status: buildStatus({
      parsed: parseRecord("busyboy/timeline", files),
      asks: [],
      waiting: false,
      changes: { kind: "unavailable", reason: "test" },
    }),
    now,
  });

const storedLines = () =>
  readFileSync(timelinePath(nodesHome, "busyboy/timeline"), "utf8").trim().split("\n");

describe("process timeline", () => {
  it("adds one entry per change to STATUS or VERIFY and none when nothing changed", async () => {
    const first = {
      "ALIGN.md": ALIGN,
      "STATUS.md": "- State: running\n",
      "VERIFY.md": VERIFY("pending"),
    };
    expect(await observe(first, "2026-11-12T10:00:00.000Z")).toEqual([
      { at: "2026-11-12T10:00:00.000Z", changes: ["기록을 처음 관찰했습니다."] },
    ]);

    expect(await observe(first, "2026-11-12T10:01:00.000Z")).toHaveLength(1);
    expect(storedLines()).toHaveLength(1);

    const proven = { ...first, "VERIFY.md": VERIFY("pass") };
    expect((await observe(proven, "2026-11-12T10:02:00.000Z")).at(-1)).toEqual({
      at: "2026-11-12T10:02:00.000Z",
      changes: ["기준 2: pending → proven"],
    });

    const done = { ...proven, "STATUS.md": "- State: done\n" };
    expect((await observe(done, "2026-11-12T10:03:00.000Z")).at(-1)?.changes).toEqual([
      "상태: running → done",
    ]);
    expect(storedLines()).toHaveLength(3);
  });

  it("stores each node under its repository and task folders", () => {
    expect(timelinePath("/home/nodes", "busyboy/clean-room")).toBe(
      "/home/nodes/busyboy/clean-room/timeline.jsonl",
    );
    expect(timelinePath("/home/nodes", "../escape")).toBe("/home/nodes/_/escape/timeline.jsonl");
  });
});
