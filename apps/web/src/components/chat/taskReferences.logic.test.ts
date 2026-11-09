import {
  EnvironmentId,
  ProjectId,
  ProjectTaskId,
  type ProjectTaskReference,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { buildTaskReferenceCatalog, taskReferenceCandidates } from "~/state/projectTeam.logic";
import { parseTaskReferenceHref, remarkTaskReferences } from "./taskReferences.logic";

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

describe("cross-project task references", () => {
  const environmentId = EnvironmentId.make("local");
  const bot = ProjectId.make("bot");
  const bench = ProjectId.make("bench");
  const botTask = { ...task(2, "자동 답변 재시도"), id: ProjectTaskId.make("task:bot-2") };
  const benchTask = { ...task(2, "성능 측정 결과 정리"), id: ProjectTaskId.make("task:bench-2") };
  const catalog = buildTaskReferenceCatalog({
    environmentId,
    contextualProjectId: null,
    projects: [
      { environmentId, id: bot, title: "next-bot" },
      { environmentId, id: bench, title: "next-benchmarks" },
    ],
    entries: [
      {
        environmentId,
        summary: { projectId: bot, taskKeyPrefix: "NB2", taskKeyAliases: ["NB"], tasks: [botTask] },
      },
      { environmentId, summary: { projectId: bench, taskKeyPrefix: "NB", tasks: [benchTask] } },
      {
        environmentId: EnvironmentId.make("remote"),
        summary: { projectId: bot, taskKeyPrefix: "NB2", tasks: [task(2, "다른 서버")] },
      },
    ],
  });

  it("links unique keys by stable task ID and presents ambiguous historical keys as choices", () => {
    const tree: MarkdownNode = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "NB2-2, NB-2" }] }],
    };
    remarkTaskReferences({ tasks: new Map(), catalog })(tree);
    const links = tree.children![0]!.children!.filter((node) => node.type === "link");
    expect(links.map((node) => node.url)).toEqual(["t3-task:task%3Abot-2", "t3-task-key:NB-2"]);
    expect(catalog.byId.size).toBe(2);
    expect(catalog.byId.get(botTask.id)?.projectTitle).toBe("next-bot");
  });

  it("recognizes keys followed by Korean particles without matching Latin identifiers", () => {
    const tree: MarkdownNode = {
      type: "root",
      children: [{ type: "text", value: "NB2-2가 끝났고 NB2-2draft는 이름입니다." }],
    };
    remarkTaskReferences({ tasks: new Map(), catalog })(tree);
    expect(tree.children!.filter((node) => node.type === "link").map((node) => node.url)).toEqual([
      "t3-task:task%3Abot-2",
    ]);
  });

  it("resolves a historical alias only within its own project context", () => {
    expect(
      taskReferenceCandidates({ ...catalog, contextualProjectId: bot }, "NB-2").map(
        (entry) => entry.task.id,
      ),
    ).toEqual([botTask.id]);
    expect(taskReferenceCandidates(catalog, "NB-2").map((entry) => entry.task.id)).toEqual([
      botTask.id,
      benchTask.id,
    ]);
  });

  it("keeps code, existing links, longer names, unknown keys and external issue URLs intact", () => {
    const tree: MarkdownNode = {
      type: "root",
      children: [
        { type: "code", value: "NB2-2" },
        { type: "inlineCode", value: "NB-2" },
        {
          type: "link",
          url: "https://example.com/NB2-2",
          children: [{ type: "text", value: "NB2-2" }],
        },
        { type: "text", value: "XNB2-2 NB2-2-draft NB2-99" },
      ],
    };
    const before = structuredClone(tree);
    remarkTaskReferences({ tasks: new Map(), catalog })(tree);
    expect(tree).toEqual(before);
  });

  it("reads stable and legacy task links and rejects malformed escapes", () => {
    expect(parseTaskReferenceHref("t3-task:task%3Abot-2")).toBe("task:bot-2");
    expect(parseTaskReferenceHref("t3-task:12")).toBe(12);
    expect(parseTaskReferenceHref("t3-task:%xx")).toBeNull();
    expect(parseTaskReferenceHref("https://example.com/task:bot-2")).toBeNull();
  });
});
