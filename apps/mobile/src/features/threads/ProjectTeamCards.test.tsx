// @vitest-environment jsdom
import {
  EnvironmentId,
  type ProjectDecisionCard,
  ThreadId,
  TURN_FAILED_OPTIONS,
  SANDBOX_ROTATION_OPTIONS,
} from "@t3tools/contracts";
import { formatRequestLink } from "@t3tools/shared/requestMessage";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  copy: vi.fn(),
  // The asked version and a later one where the lead finished step two.
  taskDetail: {
    task: {
      planCheck: {
        specVersion: 2,
        round: 3,
        status: "failed",
        verdicts: [
          { gate: "problem", pass: true, reason: "현재와 목표가 분명해요." },
          { gate: "risks", pass: false, reason: "위험이 할 일과 이어지지 않아요." },
        ],
        checker: { providerInstanceId: "claude", model: "claude-opus-4-7", threadId: "checker" },
      },
    },
    versions: [
      {
        version: 2,
        spec: {
          summary: "격자를 별자리 모양으로 바꿔요",
          goal: "이름이 잘리지 않고 폰에서도 읽혀요",
          nonGoals: "목표 편집은 하지 않아요",
          criteria: [{ id: "c1", text: "같은 데이터면 같은 모양" }],
          todos: [],
          problem: "목표 이름이 잘려서 찾기 어려워요.",
          why: "",
          currentState: "GoalGraph가 격자로 그려요.",
          risks: "150개에서 느려질 수 있어요.",
        },
      },
      {
        version: 3,
        spec: {
          summary: "",
          goal: "",
          nonGoals: "",
          criteria: [],
          todos: [{ id: "two", done: true }],
        },
      },
    ],
  },
}));
const PM = ThreadId.make("pm");
const DIRECTOR = ThreadId.make("director");
const LEAD = ThreadId.make("lead");
const PLAN =
  "목표 그래프 플랜 승인 부탁드려요.\n\n격자를 별자리 모양으로 바꾸고, 목표별 정보는 옆 패널로 옮길게요. 지금은 이름이 잘리고 폰에선 점만 보여서요.\n\n같은 데이터면 늘 같은 모양으로 뜨고, 태스크 150개에서도 안 버벅이고, 웹이랑 모바일 둘 다 되면 끝이에요. 비용은 $6~9 정도고 되돌리기 쉬워요.";
const RELEASE =
  "v0.0.20 릴리스 해도 될까요?\n\n지난 릴리스 이후 머지된 게 4개라 묶어서 내면 좋을 타이밍이에요.\n\n1. main 최신 확인\n2. 릴리스 워크플로 실행\n3. 세 플랫폼 빌드 확인\n4. 릴리스 노트 게시";

const approval: ProjectDecisionCard = {
  taskNumber: null,
  taskTitle: "BU-129 목표 그래프",
  plan: {
    summary: "계획",
    subtasks: [],
    todos: [
      { id: "one", text: "배치 바꾸기", done: true, doneWhen: "위치가 같아요", dependsOn: [] },
      {
        id: "two",
        text: "모바일 확인",
        done: false,
        doneWhen: "모바일에서도 보여요",
        dependsOn: ["one"],
      },
    ],
  },
  item: {
    id: "approval" as never,
    projectId: "a" as never,
    taskId: "task" as never,
    kind: "approval",
    question: PLAN,
    options: [],
    answer: null,
    answeredAt: null,
    askerThreadId: LEAD,
    batchId: "batch" as never,
    createdAt: "2026-11-10T03:00:00.000Z",
    supersededAt: null,
    answeredBy: null,
    specVersion: null,
    summary: null,
    verification: null,
    senderRole: null,
    senderName: null,
    details: [{ label: "비용", text: "$6~9" }],
  },
};
const decision: ProjectDecisionCard = {
  ...approval,
  plan: null,
  item: {
    ...approval.item,
    id: "decision" as never,
    kind: "decision",
    question: RELEASE,
    options: ["지금: 출시 (Recommended)", "나중에: 검토"],
    senderRole: "pm",
  },
};
const summaries = [
  {
    projectId: "a" as never,
    pmThreadId: PM,
    tasks: [{ id: "task", leadThreadId: LEAD }],
    decisionCards: [approval, decision],
  },
  {
    projectId: "director-project" as never,
    pmThreadId: DIRECTOR,
    kind: "director" as const,
    tasks: [],
    decisionCards: [],
  },
];

// DOM hosts preserve the native press/state contract so these tests exercise real hooks.
vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    className,
  }: {
    children: ReactNode;
    testID: string;
    className: string;
  }) => (
    <div data-testid={testID} className={className}>
      {children}
    </div>
  ),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityRole: string;
    accessibilityState: { checked: boolean } | undefined;
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-checked={accessibilityState?.checked}
    >
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "a", environmentId: "env", title: "busyboy" }],
}));
vi.mock("../../state/projectTeam", () => ({
  projectTeamEnvironment: { taskDetail: () => "task-detail" },
  useEnvironmentProjectTeamAttention: () => ({
    byProjectId: new Map(summaries.map((summary) => [summary.projectId, summary])),
  }),
  useAnswerDecision: () => mocks.answer,
  useSnoozeDecision: () => mocks.snooze,
  useUnsnoozeDecision: () => mocks.unsnooze,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({ data: atom === null ? null : mocks.taskDetail }),
}));

import { ProjectTeamCard, ProjectTeamCards } from "./ProjectTeamCards";
let root: Root | null = null;
let host: HTMLDivElement;
const reply = vi.fn();
const openLead = vi.fn();
function render(
  card: ProjectDecisionCard | null,
  canOperateThread: boolean,
  threadId: ThreadId = PM,
) {
  host = document.createElement("div");
  root = createRoot(host);
  const props = {
    environmentId: EnvironmentId.make("env"),
    canOperateThread,
    onReply: reply,
    onOpenLead: openLead,
  };
  act(() =>
    root!.render(
      card === null ? (
        <ProjectTeamCards {...props} threadId={threadId} />
      ) : (
        <ProjectTeamCard
          {...props}
          entry={{
            card,
            header: "Legacy header",
            sender: "busyboy · 목표 그래프 리드",
            leadThreadId: LEAD,
            replyable: true,
          }}
        />
      ),
    ),
  );
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!result) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

describe("ProjectTeamCards", () => {
  it("shows each request with its own sender and two actions inside the bubble, including approvals", () => {
    render(null, true);
    expect(host.querySelectorAll('[data-testid="request-bubble"]')).toHaveLength(2);
    expect(host.textContent).toContain("busyboy · 목표 그래프 리드");
    expect(host.textContent).toContain("busyboy · PM");
    expect(host.textContent?.includes("BU-129")).toBe(false);
    for (const actions of host.querySelectorAll('[data-testid="request-actions"]')) {
      expect([...actions.querySelectorAll("button")].map((element) => element.textContent)).toEqual(
        ["승인", "자세히 보기"],
      );
      expect(actions.closest('[data-testid="request-bubble"]') === null).toBe(false);
    }
    expect(host.textContent?.includes("위치가 같아요")).toBe(false);
    expect(host.querySelector(".line-through")?.textContent).toBe("1. 배치 바꾸기");
    expect(host.textContent).toContain("4. 릴리스 노트 게시");
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  });
  it("shows another project's plan approval in the Director chat and approves it there", async () => {
    render(null, true, DIRECTOR);
    const bubble = [...host.querySelectorAll('[data-testid="request-bubble"]')].find((element) =>
      element.textContent?.includes("목표 그래프 플랜 승인 부탁드려요."),
    );
    expect(bubble).toBeDefined();
    expect(host.textContent).toContain("busyboy · 목표 그래프 리드");
    await act(async () => button("승인").click());
    expect(mocks.answer).toHaveBeenCalledWith("env", {
      projectId: "a",
      attentionItemId: "approval",
      answer: "Approve and start",
    });
  });
  it("approves a plan with Approve and start", async () => {
    render(approval, true);
    await act(async () => button("승인").click());
    expect(mocks.answer).toHaveBeenCalledWith("env", {
      projectId: "a",
      attentionItemId: "approval",
      answer: "Approve and start",
    });
  });
  it("folds criteria and dependency numbers inside the bubble and opens the lead", () => {
    render({ ...approval, item: { ...approval.item, specVersion: 2 } }, true);
    // Live progress strikes through the step the lead finished after asking.
    expect(
      [...host.querySelectorAll("span")].find((span) => span.textContent === "2. 모바일 확인")
        ?.className,
    ).toContain("line-through");
    act(() => button("자세히 보기").click());
    expect(host.querySelector('[data-testid="request-bubble"]')?.textContent).toContain(
      "비용: $6~9",
    );
    expect(host.textContent).toContain("단계");
    expect(host.textContent).toContain("모바일에서도 보여요 · 1 다음");
    expect(host.textContent).toContain("목표 편집은 하지 않아요");
    act(() => button("전체 플랜").click());
    expect(host.querySelector('[data-testid="request-full-plan"]')?.textContent).toContain(
      "같은 데이터면 같은 모양",
    );
    act(() => button("💬 리드와 대화").click());
    expect(openLead).toHaveBeenCalledWith(LEAD);
    act(() => button("자세히 보기").click());
    expect(host.querySelector('[data-testid="request-details"]')).toBe(null);
  });
  it("keeps the plan bubble short and shows plan gates and checker verdicts under 자세히 보기", () => {
    render({ ...approval, item: { ...approval.item, specVersion: 2 } }, true);
    const bubble = host.querySelector('[data-testid="request-bubble"]')!;
    for (const hidden of ["찾기 어려워요", "150개에서 느려질", "검사 미통과", "3번째 확인"]) {
      expect(bubble.textContent?.includes(hidden)).toBe(false);
    }
    expect(
      [...host.querySelectorAll('[data-testid="request-actions"] button')].map(
        (element) => element.textContent,
      ),
    ).toEqual(["승인", "자세히 보기"]);
    act(() => button("자세히 보기").click());
    const details = host.querySelector('[data-testid="request-details"]')!.textContent!;
    const order = ["문제", "목표 이름이 잘려서 찾기 어려워요.", "현재 상태", "안 하는 것", "위험"];
    const positions = order.map((text) => details.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(details.includes("왜")).toBe(false);
    const check = [...host.querySelectorAll('[data-testid="request-plan-check"] span')].map(
      (element) => element.textContent,
    );
    expect(check).toEqual([
      "검사 미통과 · 3번째 확인 · Claude Opus 4.7",
      "문제 통과",
      "위험 미통과\n위험이 할 일과 이어지지 않아요.",
    ]);
  });
  it("hides checker verdicts for another plan version", () => {
    render({ ...approval, item: { ...approval.item, specVersion: 3 } }, true);
    act(() => button("자세히 보기").click());
    expect(host.querySelector('[data-testid="request-plan-check"]')).toBe(null);
  });
  it("hides reply and copy behind the action menu and creates a request link", async () => {
    render(approval, true);
    expect(host.textContent?.includes("답장")).toBe(false);
    // The action menu sits outside the bubble, which holds only its two buttons.
    expect(host.querySelector('[data-testid="request-bubble"]')?.textContent?.includes("⋯")).toBe(
      false,
    );
    act(() => button("요청 동작").click());
    expect(
      host
        .querySelector('[data-testid="request-message-actions"]')
        ?.closest('[data-testid="request-bubble"]'),
    ).toBe(null);
    act(() => button("답장").click());
    expect(reply).toHaveBeenCalledWith(
      formatRequestLink("approval", "목표 그래프 플랜 승인 부탁드려요."),
    );
    act(() => button("요청 동작").click());
    await act(async () => button("링크 복사").click());
    expect(mocks.copy).toHaveBeenCalledWith(
      formatRequestLink("approval", "목표 그래프 플랜 승인 부탁드려요."),
    );
  });
  it("preselects the recommended decision and sends the selected option", async () => {
    render(decision, true);
    act(() => button("자세히 보기").click());
    const options = host.querySelectorAll('[role="radio"]');
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");
    expect(options[0]?.textContent).toContain("추천");
    // Label and tradeoff split like web; the raw "(Recommended)" never shows.
    expect(options[0]?.textContent).toBe("●지금출시추천");
    expect(options[1]?.textContent).toBe("○나중에검토");
    act(() => (options[1] as HTMLButtonElement).click());
    await act(async () => button("보내기").click());
    expect(mocks.answer).toHaveBeenCalledWith("env", {
      projectId: "a",
      attentionItemId: "decision",
      answer: "나중에: 검토",
    });
  });
  it("includes the optional note with the selected answer", async () => {
    render(decision, true);
    act(() => button("자세히 보기").click());
    const input = host.querySelector("input")!;
    act(() => {
      input.value = "  내일 오전에 진행해 주세요  ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("보내기").click());
    expect(mocks.answer.mock.calls[0]?.[1].answer).toBe(
      "지금: 출시 (Recommended)\nNote: 내일 오전에 진행해 주세요",
    );
  });
  it("shows the reason, impacts and recommendation under details", () => {
    render(
      {
        ...decision,
        item: {
          ...decision.item,
          context: {
            action: "v0.0.20 릴리스를 냅니다",
            reason: "머지된 변경 네 개를 묶어서 냅니다",
            impacts: ["publish"],
            cost: null,
            reversibility: "requires_work",
            recommendation: "지금 내는 안을 추천해요",
          },
        },
      },
      true,
    );
    expect(host.textContent?.includes("머지된 변경 네 개를 묶어서 냅니다")).toBe(false);
    act(() => button("자세히 보기").click());
    const context = host.querySelector('[data-testid="request-context"]')!;
    expect(context.closest('[data-testid="request-details"]')).not.toBe(null);
    expect(context.textContent).toContain("머지된 변경 네 개를 묶어서 냅니다");
    expect(context.textContent).toContain("외부 게시");
    expect(context.textContent).toContain("되돌리려면 별도 작업 필요");
    expect(context.textContent).toContain("추천안: 지금 내는 안을 추천해요");
  });
  it("notes the plan approval's scope and warns when a request has no context", () => {
    render(
      {
        ...approval,
        item: {
          ...approval.item,
          context: {
            action: "목표 그래프 플랜을 승인합니다",
            reason: "이름이 잘려요",
            impacts: [],
            cost: null,
            reversibility: "reversible",
            recommendation: "승인을 추천해요",
          },
        },
      },
      true,
    );
    act(() => button("자세히 보기").click());
    expect(host.querySelector('[data-testid="request-context"]')?.textContent).toContain(
      "계획 승인입니다.",
    );
    render(decision, true);
    act(() => button("자세히 보기").click());
    expect(host.querySelector('[data-testid="request-context"]')?.textContent).toContain(
      "영향 확인 필요",
    );
  });
  it("shows a one-line plan approval's summary and a blocker's choices like web", () => {
    render(
      {
        ...approval,
        item: { ...approval.item, question: "목표 그래프 플랜 승인 부탁드려요.", details: null },
      },
      true,
    );
    expect(host.querySelector('[data-testid="request-bubble"]')?.textContent).toContain("계획");
    render(
      {
        ...decision,
        item: { ...decision.item, kind: "blocker", options: ["처리했어요", "나중에"] },
      },
      true,
    );
    act(() => button("자세히 보기").click());
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(2);
  });
  it("sends the recommended answer from the primary decision action", async () => {
    render(decision, true);
    await act(async () => button("승인").click());
    expect(mocks.answer.mock.calls[0]?.[1].answer).toBe("지금: 출시 (Recommended)");
  });
  it("restarts a stalled task from 다시 시작 beside 자세히 보기", async () => {
    render(
      {
        ...approval,
        plan: null,
        item: {
          ...approval.item,
          id: "stall" as never,
          kind: "blocker",
          question:
            "로그인 수정 작업이 20분째 멈춰 있어요. 다시 시작할까요?\n\n리드가 멈춰서 10분 전에 한 번 깨웠는데 그대로예요.",
          options: ["다시 시작"],
        },
      },
      true,
    );
    const actions = host.querySelector('[data-testid="request-actions"]')!;
    expect([...actions.querySelectorAll("button")].map((element) => element.textContent)).toEqual([
      "다시 시작",
      "자세히 보기",
    ]);
    await act(async () => button("다시 시작").click());
    expect(mocks.answer.mock.calls[0]?.[1].answer).toBe("다시 시작");
  });
  it("uses 처리했어요 for a regular blocker and disables sending without control", () => {
    render({ ...approval, item: { ...approval.item, kind: "blocker" } }, false);
    expect(button("처리했어요").disabled).toBe(true);
  });
  it.each([
    ["blocker", TURN_FAILED_OPTIONS],
    ["decision", SANDBOX_ROTATION_OPTIONS],
  ] as const)("preserves the existing %s recovery options", (kind, options) => {
    render({ ...approval, item: { ...approval.item, kind, options } }, true);
    expect(host.textContent).toContain("Legacy header");
    expect(button(options[0]).textContent).toBe(options[0]);
    expect(button(options[1]).textContent).toBe(options[1]);
  });
  it("keeps a failed answer retryable", async () => {
    mocks.answer.mockRejectedValueOnce(new Error("offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(approval, true);
    await act(async () => button("승인").click());
    expect(host.textContent).toContain("답을 보내지 못했어요");
    expect(button("승인").disabled).toBe(false);
    log.mockRestore();
  });
});

describe("snoozing a request", () => {
  const setSnoozed = (id: string, reason: string | null) => {
    const project = summaries[0]!;
    project.decisionCards = project.decisionCards.map((card) =>
      card.item.id === id
        ? {
            ...card,
            item: {
              ...card.item,
              snoozedAt: reason === null ? null : "2026-11-11T00:00:00.000Z",
              snoozeReason: reason,
            },
          }
        : card,
    );
  };
  afterEach(() => setSnoozed("decision", null));

  it("needs a reason, then sends it with the request", async () => {
    mocks.snooze.mockResolvedValue({ _tag: "Success" });
    render(null, true);
    const bubbles = () => host.querySelectorAll('[data-testid="request-bubble"]');
    expect(bubbles()).toHaveLength(2);
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('[aria-label="요청 보류"]')][1]!.click(),
    );
    const input = host.querySelector<HTMLInputElement>('input[aria-label="보류 이유"]')!;
    const submit = button("이유와 함께 보류");
    expect(submit.disabled).toBe(true);
    act(() => {
      input.value = "   ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("이유와 함께 보류").disabled).toBe(true);
    act(() => {
      input.value = "다음 주에 볼게";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("이유와 함께 보류").disabled).toBe(false);
    await act(async () => button("이유와 함께 보류").click());
    expect(mocks.snooze).toHaveBeenCalledWith(EnvironmentId.make("env"), {
      projectId: "a",
      attentionItemId: "decision",
      reason: "다음 주에 볼게",
    });
  });

  it("folds snoozed requests under 보류 N with the reason and brings them back", async () => {
    mocks.unsnooze.mockResolvedValue({ _tag: "Success" });
    setSnoozed("decision", "다음 주에 볼게");
    render(null, true);
    // Only the open request waits above the composer.
    expect(host.querySelectorAll('[data-testid="request-bubble"]')).toHaveLength(1);
    const section = host.querySelector('[data-testid="snoozed-cards"]')!;
    expect(section.textContent).toContain("보류 1");
    expect(section.textContent?.includes("이유:")).toBe(false);
    act(() => section.querySelector("button")!.click());
    const row = host.querySelector('[data-testid="snoozed-card-decision"]')!;
    expect(row.textContent).toContain("v0.0.20 릴리스 해도 될까요?");
    expect(row.textContent).toContain("이유: 다음 주에 볼게");
    await act(async () => button("다시 꺼내기").click());
    expect(mocks.unsnooze).toHaveBeenCalledWith(EnvironmentId.make("env"), {
      projectId: "a",
      attentionItemId: "decision",
    });
  });

  it("says so when bringing a request back fails", async () => {
    mocks.unsnooze.mockResolvedValue({ _tag: "Failure" });
    setSnoozed("decision", "다음 주에 볼게");
    render(null, true);
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="snoozed-cards"] button')!.click(),
    );
    await act(async () => button("다시 꺼내기").click());
    expect(host.textContent).toContain("다시 꺼내지 못했어요");
  });
});
