import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { formatRequestLink } from "@t3tools/shared/requestMessage";
import * as Repository from "../persistence/ProjectTeamRepository.ts";
import { relayedAnswerText } from "./AttentionRouter.ts";
import { ProjectTeamService } from "./ProjectTeamService.ts";
import {
  requestApproval,
  askPlanApproval,
  attentionContext,
  setUpManager,
  startLead,
  readyPlan,
  setSize,
  userSays,
  withTeam,
} from "./testkit.ts";

const release = "v0.0.20 릴리스 해도 될까요?\n\n수정 네 개를 묶어서 낼게요.";
const graph = "목표 그래프 플랜 승인 부탁드려요.\n\n이름이 잘리지 않게 바꿀게요.";

describe("ProjectTeamService request messages", () => {
  it.effect("rejects technical todo titles before creating an approval card", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(pm, "목표 그래프", harness.delegate);
        yield* setSize(lead);
        const read = yield* team.readSpec(lead, {});
        const plan = readyPlan(read.current.spec);
        const text = "공용 레이아웃을 시드 고정 force 배치로 바꾸기 (BU-129 이후)";
        yield* team.writeSpec(lead, {
          baseVersion: read.current.version,
          spec: { ...plan, todos: plan.todos.map((todo) => ({ ...todo, text })) },
          note: "Plan",
        });
        const error = yield* requestApproval(lead, {
          kind: "approval",
          question: graph,
          context: attentionContext({ action: "Approve" }),
        }).pipe(Effect.flip);
        assert.include(error.message, `Todo t1 '${text}':`);
        assert.include(error.message, "doneWhen/dependsOn");
        const latest = yield* team.readSpec(lead, {});
        yield* team.writeSpec(lead, {
          baseVersion: latest.current.version,
          spec: {
            ...plan,
            todos: plan.todos.map((todo) => ({
              ...todo,
              text: "노드가 늘 같은 자리에 오게 배치 바꾸기",
            })),
          },
          note: "Short titles",
        });
        const { item } = yield* askPlanApproval(lead, {
          kind: "approval",
          question: graph,
          senderName: "그래프 배치",
          context: attentionContext({ action: "Approve" }),
        });
        assert.strictEqual(item.senderRole, "lead");
        assert.strictEqual(item.senderName, "그래프 배치");
      }),
    ),
  );

  it.effect("persists lead names, derives fallbacks and identifies the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const repository = yield* Repository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const { leadThreadId: lead } = yield* startLead(
          pm,
          "BU-129 목표 그래프 (다음 단계)",
          harness.delegate,
        );
        for (const senderName of [undefined, "그래프 배치"]) {
          const { item } = yield* team.askUser(lead, {
            kind: "decision",
            question: graph,
            senderName,
            context: attentionContext({ action: "Graph" }),
          });
          const saved = Option.getOrThrow(yield* repository.getAttentionItem(item.id));
          assert.strictEqual(saved.senderRole, "lead");
          assert.strictEqual(saved.senderName, senderName ?? "목표 그래프");
        }
        const invalid = yield* team
          .askUser(lead, {
            kind: "decision",
            question: graph,
            senderName: "BU-129",
            context: attentionContext({ action: "Graph" }),
          })
          .pipe(Effect.flip);
        assert.include(invalid.message, "task keys");
        const { item } = yield* team.askUser(pm, {
          kind: "decision",
          question: graph,
          context: attentionContext({ action: "Graph" }),
        });
        assert.strictEqual(item.senderRole, "pm");
        assert.strictEqual(item.senderName, null);
      }),
    ),
  );

  it("includes the headline when relaying answers without repeating the full request", () => {
    assert.strictEqual(
      relayedAnswerText(release, "내일 하자", "user"),
      "[User answer via BusyBoy] v0.0.20 릴리스 해도 될까요? → 내일 하자",
    );
    assert.include(
      relayedAnswerText(release, "내일 하자", "pm"),
      "v0.0.20 릴리스 해도 될까요? → 내일 하자",
    );
  });
  it.effect("rejects task keys with an actionable problem", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const pm = yield* setUpManager;
        const error = yield* team
          .askUser(pm, {
            kind: "decision",
            question: "BU-129 승인 부탁드려요.",
            context: attentionContext({ action: "Approve" }),
          })
          .pipe(Effect.flip);
        assert.include(error.message, "Remove task keys");
      }),
    ),
  );

  it.effect("persists folded details and returns them after rereading", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const pm = yield* setUpManager;
        const details = [{ label: "되돌리기", text: "언제든 설정을 되돌릴 수 있어요." }];
        const { item } = yield* team.askUser(pm, {
          kind: "decision",
          question: release,
          details,
          context: attentionContext({ action: "Release" }),
        });
        assert.deepStrictEqual(item.details, details);
        const repository = yield* Repository.ProjectTeamRepository;
        const reread = yield* repository.getAttentionItem(item.id);
        assert.deepStrictEqual(Option.getOrThrow(reread).details, details);
      }),
    ),
  );

  it.effect("requires exactly one recommended option for decisions with choices", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const pm = yield* setUpManager;
        for (const options of [
          ["지금", "나중에"],
          ["지금 (Recommended)", "나중에 (추천)"],
        ]) {
          const error = yield* team
            .askUser(pm, {
              kind: "decision",
              question: release,
              options,
              context: attentionContext({ action: "Release" }),
            })
            .pipe(Effect.flip);
          assert.include(error.message, "exactly one");
        }
        const { item } = yield* team.askUser(pm, {
          kind: "decision",
          question: release,
          options: ["지금 (추천)", "나중에"],
          context: attentionContext({ action: "Release" }),
        });
        assert.strictEqual(item.options.length, 2);
      }),
    ),
  );

  for (const scenario of [
    "link",
    "words",
    "ambiguous",
    "conflict",
    "unknown",
    "not-user-words",
  ] as const) {
    it.effect(`resolves attention answers: ${scenario}`, () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService;
          const pm = yield* setUpManager;
          const first = yield* team.askUser(pm, {
            kind: "decision",
            question: graph,
            context: attentionContext({ action: "Graph" }),
          });
          const second = yield* team.askUser(pm, {
            kind: "decision",
            question: release,
            context: attentionContext({ action: "Release" }),
          });
          const answer =
            scenario === "link" || scenario === "conflict"
              ? `내일 하자 ${formatRequestLink(second.item.id, release.split("\n")[0]!)}`
              : scenario === "unknown"
                ? `내일 하자 ${formatRequestLink("unknown", "릴리스")}`
                : scenario === "ambiguous"
                  ? "목표 릴리스"
                  : "그 릴리스 건은 내일 하자";
          if (scenario !== "not-user-words") {
            userSays(harness, pm, answer);
          }
          const result = team.answerAttention(pm, {
            ...(scenario === "conflict" ? { attentionItemId: first.item.id } : {}),
            answer,
          });
          if (
            scenario === "ambiguous" ||
            scenario === "conflict" ||
            scenario === "unknown" ||
            scenario === "not-user-words"
          ) {
            const error = yield* result.pipe(Effect.flip);
            assert.include(
              error.message,
              scenario === "conflict"
                ? `This reply points at another request: ${release.split("\n")[0]}`
                : scenario === "ambiguous"
                  ? "t3-request:"
                  : scenario === "unknown"
                    ? "not open"
                    : "user",
            );
            const repository = yield* Repository.ProjectTeamRepository;
            assert.strictEqual(
              Option.getOrThrow(yield* repository.getAttentionItem(second.item.id)).answeredAt,
              null,
            );
          } else {
            const { item } = yield* result;
            assert.strictEqual(item.id, second.item.id);
            assert.strictEqual(item.answer, answer);
          }
        }),
      ),
    );
  }

  it.effect("uses a link in the latest matching user message even when the quote omits it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService;
        const pm = yield* setUpManager;
        yield* team.askUser(pm, {
          kind: "decision",
          question: graph,
          context: attentionContext({ action: "Graph" }),
        });
        const second = yield* team.askUser(pm, {
          kind: "decision",
          question: release,
          context: attentionContext({ action: "Release" }),
        });
        userSays(harness, pm, `내일 하자 ${formatRequestLink(second.item.id, "릴리스")}`);
        const { item } = yield* team.answerAttention(pm, { answer: "내일 하자" });
        assert.strictEqual(item.id, second.item.id);
      }),
    ),
  );
});
