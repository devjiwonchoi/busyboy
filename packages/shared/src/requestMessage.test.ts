import { describe, expect, it } from "vite-plus/test";
import { PLAN_APPROVAL_START } from "@t3tools/contracts";
import {
  approveAnswerFor,
  defaultRequestOption,
  formatRequestAnswer,
  plainTextProblems,
  todoTitleProblems,
  shortWorkName,
  requestSenderLabel,
  formatRequestLink,
  matchRequestReference,
  parseRequestMessage,
  requestLinkHref,
  requestLinkIds,
  requestMessageProblems,
  replyWithRequestLink,
  requestParagraphs,
  REQUEST_APPROVE_LABEL,
  REQUEST_DETAILS_LABEL,
  REQUEST_BLOCKER_DONE,
} from "./requestMessage.ts";

const A =
  "목표 그래프 플랜 승인 부탁드려요.\n\n격자를 별자리 모양으로 바꾸고, 목표별 정보는 옆 패널로 옮길게요. 지금은 이름이 잘리고 폰에선 점만 보여서요.\n\n같은 데이터면 늘 같은 모양으로 뜨고, 태스크 150개에서도 안 버벅이고, 웹이랑 모바일 둘 다 되면 끝이에요. 비용은 $6~9 정도고 되돌리기 쉬워요.";
const B =
  "v0.0.20 릴리스 해도 될까요?\n\n지난 릴리스 이후 머지된 게 4개라 묶어서 내면 좋을 타이밍이에요. 클라우드 리드, 막힘 자동 카드, 대기 알림, 윈도우 빌드 단축이 들어가요.\n\n1. main 최신 확인\n2. 릴리스 워크플로 실행\n3. 세 플랫폼 빌드 확인\n4. 릴리스 노트 게시";
const C =
  "새 태스크는 클라우드에서 시작해도 될까요?\n\n맥이 잠들면 리드도 같이 멈춰서, 밤새 돌릴 일이 아침에 그대로 남아 있어요. 클라우드에서 시작하면 맥을 닫아도 계속 돌아가요.\n\n태스크 하나에 대략 시간당 $0.3이 더 들고, 설정 하나라 언제든 되돌릴 수 있어요.";
const items = [A, B, C].map((question, i) => ({ id: `request:${i}`, question }));

describe("request messages", () => {
  it("parses a headline, paragraphs and numbered steps in either notation", () => {
    expect(
      parseRequestMessage(
        "  시작해도 될까요?\n\n이유예요.\n계속된 문장.\n\n1. 확인\n2) 실행\n\n끝이에요.  ",
      ),
    ).toEqual({
      headline: "시작해도 될까요?",
      paragraphs: ["이유예요.\n계속된 문장.", "끝이에요."],
      steps: ["확인", "실행"],
    });
    expect(parseRequestMessage("")).toEqual({ headline: "", paragraphs: [], steps: [] });
  });

  it("checks exactly which of 10 sample messages pass", () => {
    const samples = [
      A,
      B,
      C,
      "BU-129 승인 부탁드려요.",
      "계획 승인 부탁드려요.\n\n**Goal:** 화면을 고칠게요.",
      "계획 승인 부탁드려요.\n\n- 화면을 고칠게요.",
      "계획 승인 부탁드려요.\n\n`render`를 고칠게요.",
      "화면 수정해도 될까요?\n\napps/web/src/x.tsx를 바꿀게요.",
      "이 요청 처리해 주세요.\n\ntask:550e8400-e29b-41d4-a716-446655440000가 막혔어요.",
      "깃허브 토큰이 만료됐는데 새로 넣어 주실 수 있을까요?",
    ];
    expect(samples.map((sample) => requestMessageProblems(sample).length === 0)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it.each([
    ["", "headline is required"],
    ["가".repeat(81), "80 characters"],
    ["목표:", "colon"],
    ["질문\n\n# 제목", "headings"],
    ["질문\n\nVerification: check", "label lines"],
    ["질문\n\n* 하나", "bullet"],
    ["질문\n\n" + [1, 2, 3, 4].join("\n\n"), "3 paragraphs"],
    ["질문\n\n" + "가".repeat(401), "400 characters"],
    ["질문\n\n" + Array.from({ length: 9 }, (_, i) => `${i + 1}. 확인`).join("\n"), "8 numbered"],
    ["질문\n\n1. " + "가".repeat(61), "60 characters"],
    ["질문\n\nthread:abc", "internal ids"],
    ["질문\n\nproject-pm:abc", "internal ids"],
    ["질문\n\nt3-task:abc", "internal ids"],
    ["질문\n\nfoo/bar.ts", "file paths"],
    ["질문\n\npackages/shared", "file paths"],
    ["질문\n\naskUser", "camelCase"],
    ["질문\n\nask_user", "snake_case"],
  ])("reports actionable problems for %s", (text, problem) => {
    expect(requestMessageProblems(text).join("\n")).toContain(problem);
  });

  it("checks folded detail limits and technical content too", () => {
    expect(
      requestMessageProblems("승인 부탁드려요.", [
        { label: "위험", text: "arm64와 v0.0.20 지원이에요." },
      ]),
    ).toEqual([]);
    for (const text of [
      "BU-129",
      "task:abc",
      "`code`",
      "apps/web/src/x.tsx",
      "askUser",
      "ask_user",
    ]) {
      expect(
        requestMessageProblems("승인 부탁드려요.", [{ label: "설명", text }]).length,
      ).toBeGreaterThan(0);
    }
    expect(
      requestMessageProblems(
        "질문",
        Array.from({ length: 9 }, () => ({ label: "가", text: "나" })),
      ).join(),
    ).toContain("8 details");
    expect(
      requestMessageProblems("질문", [{ label: "가".repeat(21), text: "나".repeat(501) }]).join(),
    ).toContain("8 details");
  });

  it("round-trips encoded request links and preserves unknown ids for rejection", () => {
    expect(requestLinkHref("attention:한 글")).toBe("t3-request:attention%3A%ED%95%9C%20%EA%B8%80");
    expect(formatRequestLink("abc", "릴리스")).toBe("[↩ 릴리스](t3-request:abc)");
    expect(
      requestLinkIds(
        `${formatRequestLink("attention:한 글", "하나")} ${formatRequestLink("two", "둘")}`,
      ),
    ).toEqual(["attention:한 글", "two"]);
    expect(matchRequestReference(formatRequestLink(items[1]!.id, "릴리스"), items)).toEqual({
      kind: "link",
      id: items[1]!.id,
    });
    expect(matchRequestReference(formatRequestLink("unknown", "릴리스"), items)).toEqual({
      kind: "link",
      id: "unknown",
    });
  });

  it("matches meaningful words and prefixes without guessing from filler", () => {
    expect(matchRequestReference("그 릴리스 건은 내일 하자", items)).toEqual({
      kind: "words",
      id: items[1]!.id,
    });
    expect(matchRequestReference("릴리스를 내일 하자", items)).toEqual({
      kind: "words",
      id: items[1]!.id,
    });
    expect(matchRequestReference("그거 승인", items)).toEqual({ kind: "none" });
    expect(
      matchRequestReference("릴리스", [
        { id: "a", question: B },
        { id: "b", question: B },
      ]),
    ).toEqual({ kind: "ambiguous", ids: ["a", "b"] });
    // A vague reply shares no distinctive word with any open request.
    expect(matchRequestReference("지금 진행해 주세요", items.slice(0, 2))).toEqual({
      kind: "none",
    });
  });

  it("ignores mangled request links instead of throwing", () => {
    expect(requestLinkIds("t3-request:%E0 이거")).toEqual(["%E0"]);
    expect(matchRequestReference("t3-request:%E0", items)).toEqual({ kind: "link", id: "%E0" });
  });

  it("keeps a numbered line that does not start a step list in its paragraph", () => {
    expect(parseRequestMessage("배포 일정 잡아도 될까요?\n\n2026. 11월에 배포해요.")).toEqual({
      headline: "배포 일정 잡아도 될까요?",
      paragraphs: ["2026. 11월에 배포해요."],
      steps: [],
    });
  });

  it("allows everyday product names and still rejects task keys", () => {
    for (const text of [
      "iOS 빌드 확인하기",
      "UTF-8로 저장하기",
      "GPT-5 모델로 바꾸기",
      "macOS 알림 고치기",
    ]) {
      expect(plainTextProblems([text]), text).toEqual([]);
    }
    expect(plainTextProblems(["BU-129 이후 진행"])).toEqual([
      "Remove task keys; use the work's name.",
    ]);
  });

  it("shares labels and chooses the correct approve answer", () => {
    expect([REQUEST_APPROVE_LABEL, REQUEST_DETAILS_LABEL, REQUEST_BLOCKER_DONE]).toEqual([
      "승인",
      "자세히 보기",
      "처리했어요",
    ]);
    expect(approveAnswerFor({ kind: "approval", options: [] })).toBe(PLAN_APPROVAL_START);
    expect(approveAnswerFor({ kind: "blocker", options: [] })).toBe("처리했어요");
    expect(approveAnswerFor({ kind: "decision", options: [] })).toBe("승인");
    expect(approveAnswerFor({ kind: "decision", options: ["유일한 선택"] })).toBe("유일한 선택");
    // Older decisions without a recommendation fall back to the first option, like the folded list.
    expect(approveAnswerFor({ kind: "decision", options: ["먼저", "나중"] })).toBe("먼저");
    expect(defaultRequestOption([])).toBeNull();
    expect(formatRequestAnswer("먼저", "  내일 ")).toBe("먼저\nNote: 내일");
    expect(formatRequestAnswer("먼저", " ")).toBe("먼저");
    for (const marker of ["Recommended", "추천"]) {
      expect(approveAnswerFor({ kind: "decision", options: ["나중에", `지금 (${marker})`] })).toBe(
        `지금 (${marker})`,
      );
    }
  });
});

describe("request message edge cases", () => {
  it("does not read a link or a time at the start of a line as a label", () => {
    const question =
      "점검 시간 정해도 될까요?\n\nhttps://example.com/status 에서 상태를 볼 수 있어요.\n\n오후 3:30에 시작하면 저녁 전에 끝나요.";
    expect(requestMessageProblems(question)).toEqual([]);
    expect(requestMessageProblems("배포해도 될까요?\n\nGoal: 배포")).toContain(
      "Remove label lines such as Goal: or **Goal:**.",
    );
  });

  it("lets links, sentences with a colon and product names through", () => {
    expect(
      requestMessageProblems(
        "안내 페이지를 바꿔도 될까요?\n\nhttps://example.com/docs/setup.html 를 새 주소로 옮겨요. 광고 추적이 붙은 https://example.com/page?utm_source=x 도 정리해요.",
      ),
    ).toEqual([]);
    expect(
      requestMessageProblems("언제 할까요?\n\n선택지는 두 가지예요: 지금 하거나 미루기."),
    ).toEqual([]);
    expect(plainTextProblems(["iMessage, iMac, iPod, iTunes 알림 확인"])).toEqual([]);
    expect(requestMessageProblems("배포해도 될까요?\n\n끝나는 기준: 테스트 통과")).toContain(
      "Remove label lines such as Goal: or **Goal:**.",
    );
    expect(requestMessageProblems("배포해도 될까요?\n\n**Goal:** 배포")).toContain(
      "Remove label lines such as Goal: or **Goal:**.",
    );
    // Code paths outside a link are still caught.
    expect(plainTextProblems(["apps/web/src/main.tsx 를 고쳐요"])).toContain(
      "Remove file paths; describe the affected behavior.",
    );
  });

  it("falls back to the plan summary for an older one-line plan approval", () => {
    const item = {
      kind: "approval",
      question: "목표 그래프 플랜 승인 부탁드려요.",
      details: null,
      summary: "요약",
    };
    const card = (overrides: object, plan: { summary: string } | null) =>
      ({ plan, item: { ...item, ...overrides } }) as never;
    expect(requestParagraphs(card({}, { summary: "플랜 요약" }))).toEqual(["플랜 요약"]);
    expect(requestParagraphs(card({}, null))).toEqual(["요약"]);
    expect(requestParagraphs(card({ kind: "decision" }, null))).toEqual([]);
    expect(requestParagraphs(card({ question: "승인할까요?\n\n본문" }, null))).toEqual(["본문"]);
  });

  it("keeps one request link when replying again", () => {
    const first = formatRequestLink("attention:a", "목표 그래프 [플랜] 승인 부탁드려요.");
    const second = formatRequestLink("attention:b", "v0.0.20 릴리스 해도 될까요?");
    const once = replyWithRequestLink("내일 하자", first);
    expect(once).toBe(`${first} 내일 하자`);
    const twice = replyWithRequestLink(once, second);
    expect(twice).toBe(`${second} 내일 하자`);
    expect(requestLinkIds(twice)).toEqual(["attention:b"]);
  });
});

describe("request titles and senders", () => {
  it("keeps todo titles short, plain and on one line", () => {
    expect(todoTitleProblems("노드가 늘 같은 자리에 오게 배치 바꾸기")).toEqual([]);
    expect(
      todoTitleProblems("공용 레이아웃을 시드 고정 force 배치로 바꾸기 (BU-129 이후)").join(),
    ).toContain("task keys");
    for (const text of [
      "",
      "하나\n둘",
      "가".repeat(41),
      "BU-129",
      "task:abc",
      "`code`",
      "apps/web",
      "askUser",
      "ask_user",
    ]) {
      expect(todoTitleProblems(text).length).toBeGreaterThan(0);
    }
    expect(todoTitleProblems("가".repeat(40))).toEqual([]);
  });

  it("derives short work names without task keys or planning context", () => {
    expect(shortWorkName("BU-129 목표 그래프 (다음 단계) · 화면 수정")).toBe("목표 그래프");
    expect(shortWorkName("목표 그래프, 후속 작업")).toBe("목표 그래프");
    expect(shortWorkName("목표 그래프 - 후속 작업")).toBe("목표 그래프");
    expect(shortWorkName("노드가 늘 같은 자리에 오게 배치 바꾸기")).toBe(
      "노드가 늘 같은 자리에 오게",
    );
    expect(shortWorkName("가".repeat(20))).toBe("가".repeat(16));
    expect(shortWorkName("BU-129 (이후)")).toBe("");
  });

  it("labels each sender role and never exposes task keys", () => {
    const base = { projectTitle: "BusyBoy", name: "목표 그래프" };
    expect(requestSenderLabel({ ...base, role: "lead" })).toBe("BusyBoy · 목표 그래프 리드");
    expect(requestSenderLabel({ ...base, role: "lead", name: null })).toBe("BusyBoy · 리드");
    expect(requestSenderLabel({ ...base, role: "pm" })).toBe("BusyBoy · PM");
    expect(requestSenderLabel({ ...base, role: "director" })).toBe("Director");
    expect(requestSenderLabel({ ...base, role: null })).toBe(null);
    expect(
      requestSenderLabel({ role: "lead", projectTitle: "BU-12 BusyBoy", name: "BU-129" }),
    ).toBe("BusyBoy · 리드");
  });
});
