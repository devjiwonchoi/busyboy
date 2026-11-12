import {
  EnvironmentId,
  ProjectId,
  ProjectTaskId,
  type ProjectTaskReference,
} from "@t3tools/contracts";
import { act, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { buildTaskReferenceCatalog } from "~/state/projectTeam.logic";
import ChatMarkdown from "../ChatMarkdown";
import { TaskStructureLine, WaitingMarker } from "../task/TaskRelations";
import { buildTaskRelationsIndex, taskRelations } from "../task/taskRelations.logic";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({
    to: _to,
    params,
    ref,
    children,
    ...props
  }: {
    to: string;
    params: { environmentId: string; projectId: string; taskId: string };
    ref?: Ref<HTMLAnchorElement>;
    children?: ReactNode;
  }) => (
    <a
      ref={ref}
      href={`/tasks/${params.environmentId}/${params.projectId}/${params.taskId}`}
      {...props}
    >
      {children}
    </a>
  )) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useThreadTaskReferences: (() => null) as never,
  useTaskReferenceLinkContext: (() => ({
    taskKeyPrefix: null,
    threadTitles: [],
    catalog,
  })) as never,
}));

const environmentId = EnvironmentId.make("local");
const bot = ProjectId.make("bot");
const bench = ProjectId.make("bench");
function task(id: string, title: string): ProjectTaskReference {
  return {
    id: ProjectTaskId.make(id),
    number: 2,
    title,
    parentTaskId: null,
    waitsOn: [],
    stage: "inbox",
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
const botTask = task("task:bot-2", "실패한 자동 답변 재시도");
const benchTask = task("task:bench-2", "성능 측정 결과 정리");
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
  ],
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("shows title and project for a key or stable link and opens an unstarted task", async () => {
  await act(async () =>
    root.render(
      <ChatMarkdown
        cwd={undefined}
        environmentId={environmentId}
        text={
          "NB2-2 변경을 확인해 주세요. [성능 태스크](t3-task:task%3Abench-2)는 검토 중입니다. `NB2-2`"
        }
      />,
    ),
  );
  const chips = [...container.querySelectorAll<HTMLAnchorElement>("[data-task-reference-chip]")];
  expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
    "실패한 자동 답변 재시도 · next-bot",
    "성능 측정 결과 정리 · next-benchmarks",
  ]);
  expect(chips.map((chip) => chip.getAttribute("href"))).toEqual([
    "/tasks/local/bot/task:bot-2",
    "/tasks/local/bench/task:bench-2",
  ]);
  expect(chips[0]?.dataset.markdownCopy).toBe("실패한 자동 답변 재시도 · next-bot");
  expect(container.querySelector("code")?.textContent).toBe("NB2-2");
});

it("shows named project choices for an ambiguous historical key at phone width", async () => {
  await page.viewport(360, 800);
  try {
    await act(async () =>
      root.render(
        <div className="p-4">
          <ChatMarkdown
            cwd={undefined}
            environmentId={environmentId}
            text="NB-2 승인을 기다립니다."
          />
        </div>,
      ),
    );
    const choices = container.querySelector<HTMLElement>("[data-task-reference-choices]")!;
    expect(choices.textContent).toContain("프로젝트 선택:");
    expect(choices.textContent).toContain("next-bot");
    expect(choices.textContent).toContain("next-benchmarks");
    expect(choices.querySelectorAll("a").length).toBe(2);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
    await page.screenshot({ path: "__screenshots__/readable-task-references-mobile.png" });
  } finally {
    await page.viewport(1280, 900);
  }
});

it("names and links a dependency in the plan and waiting marker", async () => {
  const waitingTask = { ...botTask, waitsOn: [benchTask.id] };
  const relations = taskRelations(
    buildTaskRelationsIndex(
      [
        { environmentId, summary: { projectId: bot, taskKeyPrefix: "NB2", tasks: [waitingTask] } },
        { environmentId, summary: { projectId: bench, taskKeyPrefix: "NB", tasks: [benchTask] } },
      ],
      [
        { environmentId, id: bot, title: "next-bot" },
        { environmentId, id: bench, title: "next-benchmarks" },
      ],
    ),
    environmentId,
    waitingTask.id,
  );
  await act(async () =>
    root.render(
      <>
        <TaskStructureLine relations={relations} />
        <WaitingMarker blockedBy={relations.blockedBy} linkToTask />
        <button type="button" data-task-row>
          <WaitingMarker blockedBy={relations.blockedBy} />
        </button>
      </>,
    ),
  );
  const structure = container.querySelector("[data-task-structure-line]")!;
  expect(structure.textContent).toContain("성능 측정 결과 정리 · next-benchmarks");
  expect(structure.querySelector("a")?.getAttribute("href")).toBe(
    "/tasks/local/bench/task:bench-2",
  );
  const waiting = container.querySelector("[data-waiting-keys]")!;
  expect(waiting.textContent).toBe("성능 측정 결과 정리 · next-benchmarks");
  expect(waiting.getAttribute("href")).toBe("/tasks/local/bench/task:bench-2");
  const row = container.querySelector("[data-task-row]")!;
  expect(row.querySelector("a")).toBeNull();
  expect(row.textContent).toContain("성능 측정 결과 정리 · next-benchmarks");
});
