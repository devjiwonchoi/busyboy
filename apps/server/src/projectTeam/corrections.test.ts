import { describe, expect, it } from "@effect/vitest";
import {
  formatPlanReviewFeedback,
  type IsoDateTime,
  type ProjectCorrection,
  ProjectId,
  ProjectTaskId,
} from "@t3tools/contracts";

import {
  type CorrectionReportTask,
  classifyWorkKind,
  correctionReport,
  isDirectionChangeNote,
  isPlainApproval,
  oneLine,
  parseRevertCommits,
  planFeedbackLine,
} from "./corrections.ts";

describe("classifyWorkKind", () => {
  const kind = (title: string, files: ReadonlyArray<string>, request = "") =>
    classifyWorkKind({ title, request, files });

  it("puts release work first", () => {
    expect(kind("Fix login", [".github/workflows/release.yml", "apps/web/src/a.tsx"])).toBe(
      "release",
    );
    expect(kind("Fix login", ["scripts/release-desktop.ts"])).toBe("release");
    // Requests often quote standing rules about releases, so only the title counts.
    expect(kind("Fix login", [], "Never ask about releases")).toBe("other");
    expect(kind("다음 릴리스 준비", [])).toBe("release");
  });

  it("tells UI, server, docs and other work apart", () => {
    expect(kind("Fix login", ["apps/mobile/app/index.ts"])).toBe("ui");
    expect(kind("Fix login", ["packages/ui/Button.tsx"])).toBe("ui");
    expect(kind("설정 화면 정리", [])).toBe("ui");
    expect(kind("Fix sync", ["apps/server/src/sync.ts", "README.md"])).toBe("server");
    expect(kind("Fix sync", ["packages/shared/src/a.ts"])).toBe("server");
    expect(kind("Explain setup", ["README.md", "docs/setup.txt"])).toBe("docs");
    expect(kind("API 문서 보강", [])).toBe("docs");
    expect(kind("Tidy", ["hello.sh"])).toBe("other");
    expect(kind("Tidy", [])).toBe("other");
  });
});

describe("isPlainApproval", () => {
  it("treats a relayed approval as no correction", () => {
    for (const answer of [
      "다 승인",
      "승인",
      "OK",
      "lgtm",
      "진행해",
      "ㄱㄱ",
      "승인해줘",
      "좋아 진행해",
      "승인합니다 진행해주세요",
      "approve and start",
      "네 그대로 진행",
    ]) {
      expect(isPlainApproval(answer)).toBe(true);
    }
    for (const answer of [
      "이건 취소",
      "승인 말고 범위를 줄여 줘",
      "Request changes (review of spec v2)",
      "다",
      "좋은데 버튼은 빼 줘",
    ]) {
      expect(isPlainApproval(answer)).toBe(false);
    }
  });
});

describe("isDirectionChangeNote", () => {
  it("counts a note that turns the work around, not added scope or AFK", () => {
    expect(isDirectionChangeNote("그게 아니라 서버에서 막아 주세요")).toBe(true);
    expect(isDirectionChangeNote("앞 메시지 정정: 쉬면 실패는 비유예요")).toBe(true);
    expect(isDirectionChangeNote("Use the sidebar instead of a modal")).toBe(true);
    expect(isDirectionChangeNote("버튼은 말풍선 안 맨 아래에 둬요")).toBe(false);
    expect(isDirectionChangeNote("사용자가 자리를 비웠어요(AFK). Slack 빼기로 진행해 주세요")).toBe(
      false,
    );
  });
});

describe("oneLine", () => {
  it("collapses whitespace and clips", () => {
    expect(oneLine("  a\n\n b  ")).toBe("a b");
    expect(oneLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("planFeedbackLine", () => {
  it("takes the first inline comment, else the overall note", () => {
    const both = formatPlanReviewFeedback({
      specVersion: 2,
      overall: "Smaller, please.",
      comments: [
        { section: "Goal", quote: "dark mode   everywhere", comment: "web only" },
        { section: "Todos", quote: "t2", comment: "drop it" },
      ],
    });
    expect(planFeedbackLine(both)).toBe('"dark mode everywhere" → web only');
    const overall = formatPlanReviewFeedback({
      specVersion: null,
      overall: "Smaller, please.\nAnd faster.",
      comments: [],
    });
    expect(planFeedbackLine(overall)).toBe("Smaller, please.");
  });

  it("falls back to the first line after the header", () => {
    expect(planFeedbackLine("Request changes\n\n로그인 말고 설정부터")).toBe(
      "로그인 말고 설정부터",
    );
    expect(planFeedbackLine("그게 아니라 웹만 해줘")).toBe("그게 아니라 웹만 해줘");
  });
});

describe("parseRevertCommits", () => {
  const record = (sha: string, subject: string, body = "", date = "2026-11-05T10:00:00+09:00") =>
    `${sha}\x1f${date}\x1f${subject}\x1f${body}\x1e`;

  it("finds reverted pull requests from the subject or the Reverts line", () => {
    const log = [
      record("a1", 'Revert "Add dark mode (#12)" (#20)', "This reverts commit abc.\n"),
      record("b2", "Revert dark mode", "Reverts acme/app#33\n\nThis reverts commit def."),
      record("c3", "Add billing (#40)", "Adds billing."),
      record("d4", 'Revert "Something without a number"', "This reverts commit 123."),
      record("e5", 'Revert "Revert "Add dark mode (#12)""', "This reverts commit a1."),
    ].join("\n");
    expect(parseRevertCommits(log)).toEqual([
      {
        sha: "a1",
        prNumber: 12,
        subject: 'Revert "Add dark mode (#12)" (#20)',
        committedAt: "2026-11-05T01:00:00.000Z",
      },
      {
        sha: "b2",
        prNumber: 33,
        subject: "Revert dark mode",
        committedAt: "2026-11-05T01:00:00.000Z",
      },
    ]);
    expect(parseRevertCommits("")).toEqual([]);
  });
});

describe("correctionReport", () => {
  const P1 = ProjectId.make("p1");
  const P2 = ProjectId.make("p2");
  const NOW = "2026-11-10T00:00:00.000Z" as IsoDateTime;
  const SINCE = "2026-08-12T00:00:00.000Z" as IsoDateTime;
  const OLD = "2026-01-01T00:00:00.000Z" as IsoDateTime;
  const PROJECTS = [
    { projectId: P1, name: "Web" },
    { projectId: P2, name: "API" },
  ];

  const task = (id: string, patch: Partial<CorrectionReportTask> = {}): CorrectionReportTask => ({
    id: ProjectTaskId.make(id),
    projectId: P1,
    projectName: "Web",
    key: `W-${id}`,
    title: `Task ${id}`,
    stage: "running",
    prUrl: null,
    workKind: "ui",
    planAnswered: true,
    updatedAt: NOW,
    ...patch,
  });
  let n = 0;
  const correction = (
    taskId: string,
    patch: Partial<ProjectCorrection> = {},
  ): ProjectCorrection => {
    n += 1;
    return {
      id: `c${n}`,
      projectId: P1,
      taskId: ProjectTaskId.make(taskId),
      kind: "plan_changes",
      stage: "plan",
      workKind: "ui",
      userText: `words ${n}`,
      whatDiffered: `differed ${n}`,
      sourceKey: `k${n}`,
      backfilled: false,
      createdAt: NOW,
      ...patch,
    };
  };

  it("counts eligible, corrected and passed tasks per project, work kind and stage", () => {
    const tasks = [
      // Corrected at the plan and again at its pull request.
      task("1", { stage: "in_review", prUrl: "https://github.com/a/b/pull/1" }),
      // Clean: passes every stage it reached.
      task("2", { stage: "done", prUrl: "https://github.com/a/b/pull/2" }),
      task("3", { stage: "running" }),
      // Server work, corrected while running.
      task("4", { workKind: "server", planAnswered: false }),
      // Cancelled and old tasks don't count.
      task("5", { stage: "cancelled" }),
      task("6", { updatedAt: OLD }),
      task("7", { projectId: P2, projectName: "API", workKind: "server" }),
    ];
    const corrections = [
      correction("1"),
      correction("1", { kind: "pr_change_request", stage: "pr" }),
      correction("3"),
      correction("4", { kind: "direction_change", stage: "running", workKind: "server" }),
      // Before the window: ignored for rates.
      correction("2", { createdAt: OLD, backfilled: true }),
    ];
    const report = correctionReport({
      projects: PROJECTS,
      tasks,
      corrections,
      since: SINCE,
      recentLimit: 3,
    });

    const row = (projectId: ProjectId, workKind: string | null) =>
      report.rates.find((entry) => entry.projectId === projectId && entry.workKind === workKind)!;
    const stage = (projectId: ProjectId, workKind: string | null, name: string) =>
      row(projectId, workKind).stages.find((entry) => entry.stage === name)!;

    expect(stage(P1, null, "plan")).toEqual({
      stage: "plan",
      eligible: 3,
      corrected: 2,
      passed: 1,
      rate: 2 / 3,
    });
    expect(stage(P1, null, "running")).toEqual({
      stage: "running",
      eligible: 4,
      corrected: 1,
      passed: 3,
      rate: 0.25,
    });
    expect(stage(P1, null, "pr")).toMatchObject({ eligible: 2, corrected: 1, passed: 1 });
    expect(stage(P1, null, "merged")).toMatchObject({ eligible: 1, corrected: 0, rate: 0 });
    expect(stage(P1, null, "task")).toMatchObject({ eligible: 4, corrected: 3, passed: 1 });
    expect(stage(P1, "ui", "task")).toMatchObject({ eligible: 3, corrected: 2, passed: 1 });
    expect(stage(P1, "server", "running")).toMatchObject({ eligible: 1, corrected: 1, rate: 1 });
    expect(stage(P2, null, "task")).toMatchObject({ eligible: 1, corrected: 0, passed: 1 });

    expect(report.recent.map((entry) => entry.taskKey)).toEqual(["W-4", "W-3", "W-1"]);
    expect(report.recent[0]).toMatchObject({ projectName: "Web", title: "Task 4" });
    expect(report.backfilled).toEqual({
      plan_changes: 1,
      direction_change: 0,
      pr_change_request: 0,
      revert: 0,
    });
  });

  it("groups repeated corrections and suggests a rule at three", () => {
    const tasks = [task("1"), task("2"), task("3"), task("4", { workKind: "server" })];
    const twice = correctionReport({
      projects: PROJECTS,
      tasks,
      corrections: [correction("1"), correction("2")],
      since: SINCE,
      recentLimit: 20,
    });
    expect(twice.repeated).toHaveLength(1);
    expect(twice.repeated[0]).toMatchObject({
      projectName: "Web",
      workKind: "ui",
      stage: "plan",
      count: 2,
      suggestRule: false,
    });

    const thrice = correctionReport({
      projects: PROJECTS,
      tasks,
      corrections: [
        correction("1", { whatDiffered: "웹만" }),
        correction("2", { whatDiffered: "모바일 빼고" }),
        correction("3", { whatDiffered: "버튼 색" }),
        correction("4", { workKind: "server" }),
      ],
      since: SINCE,
      recentLimit: 20,
    });
    expect(thrice.repeated).toEqual([
      {
        projectId: P1,
        projectName: "Web",
        workKind: "ui",
        stage: "plan",
        count: 3,
        examples: ["버튼 색", "모바일 빼고", "웹만"],
        suggestRule: true,
      },
    ]);

    const serverOnly = correctionReport({
      projects: PROJECTS,
      tasks,
      corrections: [correction("1"), correction("4", { workKind: "server" })],
      since: SINCE,
      workKind: "server",
      recentLimit: 20,
    });
    expect(serverOnly.recent.map((entry) => entry.taskKey)).toEqual(["W-4"]);
    expect(serverOnly.rates.map((entry) => [entry.projectId, entry.workKind])).toEqual([
      [P1, null],
      [P1, "server"],
      [P2, null],
    ]);
  });
});
