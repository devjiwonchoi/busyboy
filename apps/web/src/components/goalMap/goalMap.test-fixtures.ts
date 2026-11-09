import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
  WorkspaceGoal,
} from "@t3tools/contracts";
import { makeProjectManagerSummaryFixture } from "~/test-fixtures";

export const GOAL_MAP_NOW = "2026-11-09T12:00:00.000Z";

export function mapTask(
  id: string,
  number: number,
  title: string,
  overrides: Partial<ProjectTaskReference> = {},
): ProjectTaskReference {
  return {
    id: id as never,
    number,
    title,
    parentTaskId: null,
    waitsOn: [],
    stage: "inbox",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: GOAL_MAP_NOW,
    checks: null,
    ...overrides,
  };
}

export function mapCard(
  taskId: string,
  projectId: string,
  kind: "approval" | "decision",
): ProjectDecisionCard {
  return {
    taskNumber: 123,
    taskTitle: "가입 승인 흐름",
    plan: null,
    item: {
      id: `card-${taskId}` as never,
      projectId: projectId as never,
      taskId: taskId as never,
      kind,
      question: "플랜을 승인할까요?",
      options: [],
      answer: null,
      answeredAt: null,
      askerThreadId: null,
      batchId: "batch" as never,
      createdAt: GOAL_MAP_NOW,
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
}

function goal(
  id: string,
  position: number,
  title: string,
  links: { projectId: string; taskId: string | null }[],
): WorkspaceGoal {
  return {
    id: id as never,
    title,
    position,
    detail: null,
    status: "active",
    links: links as never,
    createdAt: GOAL_MAP_NOW,
    updatedAt: GOAL_MAP_NOW,
  };
}

export const GOAL_MAP_PROJECTS = [
  ["busyboy", "BB", "busyboy"],
  ["site", "SI", "site"],
  ["infra", "IN", "infra"],
  ["app", "AP", "app"],
  ["docs", "DO", "docs"],
  ["director", "DR", "디렉터"],
] as const;

/**
 * Four active goals over five projects: a user-turn approval, a four-task waits-on
 * chain, done work, and one open task no goal covers.
 */
export function goalMapFixture(): {
  environmentId: EnvironmentId;
  summary: ProjectTeamAttentionSummary;
}[] {
  const entry = (
    projectId: string,
    prefix: string,
    overrides: Partial<ProjectTeamAttentionSummary> = {},
  ) => ({
    environmentId: "env-1" as EnvironmentId,
    summary: makeProjectManagerSummaryFixture({
      projectId: projectId as never,
      pmThreadId: `pm-${projectId}` as never,
      taskKeyPrefix: prefix,
      ...overrides,
    }),
  });
  return [
    entry("busyboy", "BB", {
      decisionCards: [mapCard("bb-123", "busyboy", "approval")],
      tasks: [
        mapTask("bb-117", 117, "설정 화면 정리", { stage: "done" }),
        mapTask("bb-118", 118, "알림 배지 고치기", { stage: "done" }),
        mapTask("bb-119", 119, "로그인 화면 다시 만들기", {
          stage: "running",
          leadThreadId: "lead-119" as never,
        }),
        mapTask("bb-120", 120, "세션 저장소 옮기기", {
          stage: "planning",
          waitsOn: ["bb-119" as never],
        }),
        mapTask("bb-121", 121, "온보딩 안내 문구 정리", { waitsOn: ["bb-120" as never] }),
        mapTask("bb-122", 122, "첫 실행 튜토리얼", {
          waitsOn: ["bb-121" as never],
          parentTaskId: "bb-119" as never,
        }),
        mapTask("bb-123", 123, "가입 승인 흐름", { stage: "planning" }),
      ],
    }),
    entry("site", "SI", {
      tasks: [
        mapTask("si-5", 5, "빌드 경고 없애기", { stage: "blocked" }),
        // No goal covers the landing copy.
        mapTask("si-6", 6, "랜딩 페이지 문구"),
      ],
    }),
    entry("infra", "IN", {
      tasks: [
        mapTask("in-1", 1, "CI 캐시 고치기", { stage: "running" }),
        mapTask("in-2", 2, "러너 이미지 올리기", { stage: "done" }),
        mapTask("in-3", 3, "빌드 시간 재기", { stage: "done" }),
      ],
    }),
    entry("app", "AP", {
      tasks: [
        mapTask("ap-1", 1, "스토어 스크린샷 만들기", { stage: "inbox" }),
        mapTask("ap-2", 2, "푸시 알림 붙이기", { stage: "inbox" }),
        mapTask("ap-3", 3, "아이콘 교체", { stage: "done" }),
      ],
    }),
    entry("docs", "DO", {
      tasks: [
        mapTask("do-1", 1, "설치 안내 고치기", { stage: "done" }),
        mapTask("do-2", 2, "FAQ 쓰기", { stage: "done" }),
      ],
    }),
    entry("director", "DR", {
      kind: "director",
      pmThreadId: "director-thread" as never,
      persona: { name: "Nova", avatar: { kind: "emoji", emoji: "🛰️" }, voice: "chill" } as never,
      briefing: "**온보딩 개선**은 승인 1건을 기다리고 있어요",
      goals: [
        goal("goal-onboarding", 0, "온보딩 개선", [{ projectId: "busyboy", taskId: null }]),
        goal("goal-build", 1, "빌드 안정화", [
          { projectId: "infra", taskId: null },
          { projectId: "site", taskId: "si-5" },
        ]),
        goal("goal-mobile", 2, "모바일 출시", [{ projectId: "app", taskId: null }]),
        goal("goal-docs", 3, "문서 정리", [{ projectId: "docs", taskId: null }]),
      ],
    } as Partial<ProjectTeamAttentionSummary>),
  ];
}
