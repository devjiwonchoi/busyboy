import { EnvironmentId, type ProjectDecisionCard, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const PM_A = ThreadId.make("pm-a");
const PM_B = ThreadId.make("pm-b");
const DIRECTOR = ThreadId.make("pm-director");

function card(
  projectId: string,
  id: string,
  overrides: Partial<ProjectDecisionCard["item"]> = {},
  taskTitle = "Jota",
): ProjectDecisionCard {
  return {
    taskNumber: null,
    taskTitle,
    plan: null,
    item: {
      id: id as never,
      projectId: projectId as never,
      taskId: null,
      kind: "blocker",
      question:
        "Jota 막힘: 자동 권한 검사가 작업을 거부했어요\n\n거부된 작업: `gh workflow run release.yml --ref main`",
      options: ["진행해도 돼요: 내 지시로 다시 시도", "내가 직접 실행할게요"],
      answer: null,
      answeredAt: null,
      askerThreadId: PM_A,
      batchId: "batch" as never,
      createdAt: "2026-11-10T03:00:00.000Z",
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
      ...overrides,
    },
  };
}

const summaries = [
  {
    projectId: "a" as never,
    pmThreadId: PM_A,
    tasks: [],
    decisionCards: [card("a", "blocker-a")],
  },
  {
    projectId: "b" as never,
    pmThreadId: PM_B,
    tasks: [{ id: "task-b" as never }],
    decisionCards: [
      card("b", "decision-b", { kind: "decision", createdAt: "2026-11-10T02:00:00.000Z" }, "Mika"),
      card("b", "answered-b", { answeredAt: "2026-11-10T02:30:00.000Z" }, "Mika"),
      card("b", "approval-b", { kind: "approval" }, "Plan task"),
    ],
  },
  {
    projectId: "director" as never,
    pmThreadId: DIRECTOR,
    kind: "director" as const,
    tasks: [],
    decisionCards: [
      card(
        "director",
        "director-decision",
        { kind: "decision", taskId: "task-b" as never, createdAt: "2026-11-10T04:00:00.000Z" },
        "Payments API",
      ),
    ],
  },
];

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "a", environmentId: "env", title: "busyboy" },
    { id: "b", environmentId: "env", title: "next-benchmarks" },
  ],
}));
vi.mock("../../state/projectTeam", () => ({
  useEnvironmentProjectTeamAttention: () => ({
    byProjectId: new Map(summaries.map((summary) => [summary.projectId, summary])),
  }),
  useAnswerDecision: () => vi.fn(),
}));

import { ProjectTeamCards } from "./ProjectTeamCards";
import { cardOptionLabel, openTeamCardsForThread } from "./projectTeamCards.logic";

const render = (threadId: ThreadId) =>
  renderToStaticMarkup(
    <ProjectTeamCards
      environmentId={EnvironmentId.make("env")}
      threadId={threadId}
      canOperateThread
    />,
  );

describe("ProjectTeamCards", () => {
  it("shows a PM's open blocker with its project name and answer options", () => {
    const markup = render(PM_A);
    expect(markup).toContain("Blocker · Jota · busyboy");
    expect(markup).toContain("Jota 막힘: 자동 권한 검사가 작업을 거부했어요");
    expect(markup).toContain("gh workflow run release.yml --ref main");
    expect(markup).toContain("진행해도 돼요");
    expect(markup).toContain("내가 직접 실행할게요");
    expect(markup).not.toContain("next-benchmarks");
  });

  it("shows every project's open cards in the Director's chat, oldest first", () => {
    const markup = render(DIRECTOR);
    const decision = markup.indexOf("Decision · Mika · next-benchmarks");
    const blocker = markup.indexOf("Blocker · Jota · busyboy");
    expect(decision).toBeGreaterThanOrEqual(0);
    expect(blocker).toBeGreaterThan(decision);
    // Answered cards and plan approvals stay off the phone's list.
    expect(markup).not.toContain("Plan task");
    // The Director's own card names the project of the task it is about.
    expect(markup).toContain("Decision · Payments API · next-benchmarks");
    expect(markup.match(/project-team-card-/g)).toHaveLength(3);
  });

  it("shows nothing in other threads", () => {
    expect(render(ThreadId.make("lead-1"))).toBe("");
  });
});

describe("projectTeamCards logic", () => {
  it("keeps only open blocker and decision cards for the thread", () => {
    expect(
      openTeamCardsForThread(summaries as never, PM_B, () => "B").map((entry) => entry.header),
    ).toEqual(["Decision · Mika · B"]);
  });

  it("shortens options to their label", () => {
    expect(cardOptionLabel("진행해도 돼요: 내 지시로 다시 시도")).toBe("진행해도 돼요");
    expect(cardOptionLabel("가드만 먼저 — 오늘 배포 (Recommended)")).toBe("가드만 먼저");
    expect(cardOptionLabel("내가 직접 실행할게요")).toBe("내가 직접 실행할게요");
  });
});
