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
  copy: vi.fn(),
  // The asked version and a later one where the lead finished step two.
  taskDetail: {
    versions: [
      {
        version: 2,
        spec: {
          summary: "격자를 별자리 모양으로 바꿔요",
          goal: "이름이 잘리지 않고 폰에서도 읽혀요",
          nonGoals: "목표 편집은 하지 않아요",
          criteria: [{ id: "c1", text: "같은 데이터면 같은 모양" }],
          todos: [],
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
  useEnvironmentProjectTeamAttention: () => ({ byProjectId: new Map([["a", summaries[0]]]) }),
  useAnswerDecision: () => mocks.answer,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({ data: atom === null ? null : mocks.taskDetail }),
}));

import { ProjectTeamCard, ProjectTeamCards } from "./ProjectTeamCards";
let root: Root | null = null;
let host: HTMLDivElement;
const reply = vi.fn();
const openLead = vi.fn();
function render(card: ProjectDecisionCard | null, canOperateThread: boolean) {
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
        <ProjectTeamCards {...props} threadId={PM} />
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
  it("sends the recommended answer from the primary decision action", async () => {
    render(decision, true);
    await act(async () => button("승인").click());
    expect(mocks.answer.mock.calls[0]?.[1].answer).toBe("지금: 출시 (Recommended)");
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
