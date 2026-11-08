import { ProjectTaskId, type ProjectTaskReference } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { remarkTaskReferences } from "./taskReferences.logic";

function task(number: number, title: string): ProjectTaskReference {
  return {
    id: ProjectTaskId.make(`task-${number}`),
    number,
    parentTaskId: null,
    waitsOn: [],
    title,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    updatedAt: null,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
  };
}

const TASKS = new Map([
  [1, task(1, "Rename the text-selection toolbar")],
  [12, task(12, "Fix login")],
]);
const THREAD_TITLES = ["CU eval chrome-form #1", "#12 follow-up", "Fix #1 regression"];

/** Runs the plugin over one paragraph and returns its parts: text, or "[link → t3-task:N]". */
function link(text: string, children: MarkdownNode[] = [{ type: "text", value: text }]) {
  const tree: MarkdownNode = { type: "root", children: [{ type: "paragraph", children }] };
  remarkTaskReferences({ tasks: TASKS, taskKeyPrefix: "BU", threadTitles: THREAD_TITLES })(tree);
  return tree.children![0]!.children!.map((node) =>
    node.type === "link" ? `[${node.children![0]!.value} → ${node.url}]` : node.value,
  );
}

describe("remarkTaskReferences", () => {
  it("leaves #N alone when it ends a thread's title", () => {
    expect(link("CU eval chrome-form #1 is waiting on you")).toEqual([
      "CU eval chrome-form #1 is waiting on you",
    ]);
    expect(link('The thread "cu eval chrome-form #1" asked to allow Chrome.')).toEqual([
      'The thread "cu eval chrome-form #1" asked to allow Chrome.',
    ]);
  });

  it("leaves #N alone anywhere inside a thread's title", () => {
    expect(link("Opened #12 follow-up and Fix #1 regression.")).toEqual([
      "Opened #12 follow-up and Fix #1 regression.",
    ]);
    // Only the whole title counts: "#12 later" is not the "#12 follow-up" thread.
    expect(link("#12 later")).toEqual(["[#12 → t3-task:12]", " later"]);
  });

  it("still links #N that is not part of a thread title", () => {
    expect(link("Started #1 and chrome-form #12.")).toEqual([
      "Started ",
      "[#1 → t3-task:1]",
      " and chrome-form ",
      "[#12 → t3-task:12]",
      ".",
    ]);
    // A title must start at a word boundary to count.
    expect(link("XCU eval chrome-form #1")).toEqual(["XCU eval chrome-form ", "[#1 → t3-task:1]"]);
  });

  it("links task keys with the project's prefix", () => {
    expect(link("BU-1 is blocked by BU-12.")).toEqual([
      "[BU-1 → t3-task:1]",
      " is blocked by ",
      "[BU-12 → t3-task:12]",
      ".",
    ]);
  });

  it("does not link keys inside longer words, other prefixes or unknown tasks", () => {
    expect(link("XBU-1 BU-12a BU-1-draft AB-1 BU-99 #99")).toEqual([
      "XBU-1 BU-12a BU-1-draft AB-1 BU-99 #99",
    ]);
  });

  it("leaves code alone", () => {
    expect(link("", [{ type: "inlineCode", value: "BU-1 #1" }])).toEqual(["BU-1 #1"]);
  });
});
