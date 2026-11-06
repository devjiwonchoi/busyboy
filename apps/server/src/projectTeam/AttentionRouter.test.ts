import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { relayedAnswerText } from "./AttentionRouter.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, startLead, userSays, withTeam } from "./testkit.ts";

describe("AttentionRouter", () => {
  it.effect("closes a task's open cards when it is cancelled or done", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const cancelled = yield* startLead(pm, "Group sidebar tasks", harness.delegate);
        const finished = yield* startLead(pm, "Hello", harness.delegate);
        const kept = yield* startLead(pm, "Goodbye", harness.delegate);
        const approval = yield* team.askUser(cancelled.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        yield* team.askUser(cancelled.leadThreadId, { kind: "decision", question: "Which?" });
        yield* team.askUser(finished.leadThreadId, { kind: "blocker", question: "Token?" });
        const open = yield* team.askUser(kept.leadThreadId, { kind: "decision", question: "A?" });
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 4);

        yield* team.updateTask(pm, { taskId: cancelled.task.id, stage: "cancelled" });
        yield* team.updateTask(finished.leadThreadId, { stage: "done", resultSummary: "Done." });

        const snapshot = (yield* team.attentionSnapshot).projects[0]!;
        assert.strictEqual(snapshot.openCount, 1);
        assert.strictEqual(snapshot.presence.waitingOnUser, 1);
        const status = yield* team.teamStatus(pm, {});
        assert.deepStrictEqual(
          status.openAttention.map((item) => item.id),
          [open.item.id],
        );
        // The PM gets a clear refusal instead of a failed relay to a stopped lead.
        const answer = yield* team
          .answerAttention(pm, { attentionItemId: approval.item.id, answer: "Yes." })
          .pipe(Effect.flip);
        assert.include(answer.message, "its task ended");
      }),
    ),
  );

  it.effect("batches questions raised within two minutes into one notification", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const a = yield* startLead(pm, "Hello", harness.delegate);
        const b = yield* startLead(pm, "Goodbye", harness.delegate);

        const first = yield* team.askUser(a.leadThreadId, {
          kind: "approval",
          question: "Plan A?",
        });
        yield* TestClock.adjust("1 minute");
        const second = yield* team.askUser(b.leadThreadId, {
          kind: "approval",
          question: "Plan B?",
        });
        yield* TestClock.adjust("90 seconds");
        const third = yield* team.askUser(a.leadThreadId, {
          kind: "decision",
          question: "Tabs or spaces?",
          options: ["tabs", "spaces"],
        });

        const snapshot = yield* team.attentionSnapshot;
        assert.strictEqual(snapshot.projects[0]?.openCount, 3);
        assert.deepStrictEqual(
          new Set([first.item.batchId, second.item.batchId, third.item.batchId]).size,
          1,
        );
        assert.strictEqual(snapshot.projects[0]?.latestBatchId, first.item.batchId);

        yield* TestClock.adjust("3 minutes");
        const later = yield* team.askUser(b.leadThreadId, {
          kind: "blocker",
          question: "Need a token.",
        });
        assert.notStrictEqual(later.item.batchId, first.item.batchId);
      }),
    ),
  );

  it.effect("relays the user's answer to the task lead that asked", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        userSays(harness, pm, "Yes, go ahead.");

        const answered = yield* team.answerAttention(pm, {
          attentionItemId: item.id,
          answer: "Yes, go ahead.",
        });
        assert.strictEqual(answered.item.answer, "Yes, go ahead.");
        assert.strictEqual(answered.item.answeredBy, "pm");
        const [relay] = yield* Ref.get(harness.sent);
        assert.strictEqual(relay?.threadId, lead.leadThreadId);
        assert.strictEqual(relay?.senderThreadId, pm);
        assert.strictEqual(relay?.mode, "auto");
        assert.strictEqual(
          relay?.text,
          "[User's chat answer, relayed by BusyBoy PM] Approve the plan? → Yes, go ahead.",
        );
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 0);

        const again = yield* team
          .answerAttention(pm, { attentionItemId: item.id, answer: "No." })
          .pipe(Effect.flip);
        assert.include(again.message, "already answered");
        const leadAnswers = yield* team
          .answerAttention(lead.leadThreadId, { attentionItemId: item.id, answer: "Sure." })
          .pipe(Effect.flip);
        assert.include(leadAnswers.message, "not available to a task lead");
      }),
    ),
  );

  it.effect("keeps the question open when relaying the answer fails", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        userSays(harness, pm, "Yes.");

        harness.sendFailures.remaining = 1;
        yield* team
          .answerAttention(pm, { attentionItemId: item.id, answer: "Yes." })
          .pipe(Effect.flip);
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 1);

        const retried = yield* team.answerAttention(pm, {
          attentionItemId: item.id,
          answer: "Yes.",
        });
        assert.strictEqual(retried.item.answer, "Yes.");
        const relays = yield* Ref.get(harness.sent);
        assert.deepStrictEqual(
          relays.map((relay) => relay.threadId),
          [lead.leadThreadId],
        );
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 0);
      }),
    ),
  );

  it.effect(
    "shows each question as a card and replaces an unanswered approval with the newer plan",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          const lead = yield* startLead(pm, "Fix login", harness.delegate);
          const first = yield* team.askUser(lead.leadThreadId, {
            kind: "approval",
            question: "Plan v1?",
          });
          yield* TestClock.adjust("1 minute");
          const second = yield* team.askUser(lead.leadThreadId, {
            kind: "approval",
            question: "Plan v2?",
          });

          const summary = (yield* team.attentionSnapshot).projects[0];
          assert.strictEqual(summary?.openCount, 1);
          assert.deepStrictEqual(
            summary?.decisionCards.map((card) => [
              card.taskTitle,
              card.item.question,
              card.item.supersededAt === null,
            ]),
            [
              ["Fix login", "Plan v1?", false],
              ["Fix login", "Plan v2?", true],
            ],
          );
          const stale = yield* team
            .answerDecision({ projectId: PROJECT_ID, attentionItemId: first.item.id, answer: "Ok" })
            .pipe(Effect.flip);
          assert.include(stale.message, "a newer question replaced it");
          assert.strictEqual(second.item.supersededAt, null);

          // Cards show on the task page and above the PM composer; the PM is not woken for them.
          const toPm = yield* harness.messagesTo(pm);
          assert.isFalse(toPm.some((text) => text.includes("Plan v2?")));
        }),
      ),
  );

  it.effect("sends a card answer straight to the task lead without waking the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fix login", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
          options: ["Approve", "Request changes"],
        });

        const answered = yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: "Approve\nNote: keep it small",
        });
        assert.strictEqual(answered.item.answer, "Approve\nNote: keep it small");
        assert.strictEqual(answered.item.answeredBy, "user");
        const [relay] = yield* Ref.get(harness.sent);
        assert.strictEqual(relay?.threadId, lead.leadThreadId);
        assert.strictEqual(relay?.senderThreadId, pm);
        assert.strictEqual(
          relay?.text,
          "[User answer via BusyBoy] Approve the plan? → Approve\nNote: keep it small",
        );
        const summary = (yield* team.attentionSnapshot).projects[0];
        assert.strictEqual(summary?.openCount, 0);
        assert.strictEqual(summary?.decisionCards[0]?.item.answer, "Approve\nNote: keep it small");
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);
      }),
    ),
  );

  it.effect("rejects a PM answer on an approval or decision card the user did not write", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        // Written before the card appeared, so it cannot answer it.
        userSays(harness, pm, "Approve and start", { id: "early" });
        yield* TestClock.adjust("1 minute");
        const approval = yield* team.askUser(lead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        const decision = yield* team.askUser(lead.leadThreadId, {
          kind: "decision",
          question: "Tabs or spaces?",
          options: ["tabs", "spaces"],
        });
        const later = "2026-11-04T00:02:00.000Z";
        // An agent or the server writing as the user does not count either.
        userSays(harness, pm, "Approve and start", {
          id: "from-agent",
          createdAt: later,
          createdBy: "agent",
          creationSource: "mcp",
        });
        userSays(harness, pm, "spaces", {
          id: "from-server",
          createdAt: later,
          creationSource: "server",
        });

        for (const [item, answer] of [
          [approval.item, "Approve and start"],
          [decision.item, "spaces"],
        ] as const) {
          const error = yield* team
            .answerAttention(pm, { attentionItemId: item.id, answer })
            .pipe(Effect.flip);
          assert.strictEqual(error.message, ProjectTeamService.PM_RELAY_NOT_USER_WORDS);
        }
        assert.deepStrictEqual(yield* Ref.get(harness.sent), []);
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 2);
      }),
    ),
  );

  it.effect("accepts a PM answer quoted from the user's chat, ignoring case and spacing", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "approval",
          question: "Approve the plan?",
        });
        userSays(harness, pm, "좋아요.\n  전부   승인 해주세요");

        const answered = yield* team.answerAttention(pm, {
          attentionItemId: item.id,
          answer: " 전부 승인 ",
        });
        assert.strictEqual(answered.item.answeredBy, "pm");
        const [relay] = yield* Ref.get(harness.sent);
        assert.strictEqual(
          relay?.text,
          "[User's chat answer, relayed by BusyBoy PM] Approve the plan? →  전부 승인 ",
        );
      }),
    ),
  );

  it.effect("lets the PM answer a blocker without quoting the user", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "blocker",
          question: "Need a token.",
        });

        const answered = yield* team.answerAttention(pm, {
          attentionItemId: item.id,
          answer: "The token is in the vault.",
        });
        assert.strictEqual(answered.item.answeredBy, "pm");
        const [relay] = yield* Ref.get(harness.sent);
        assert.strictEqual(
          relay?.text,
          "[User's chat answer, relayed by BusyBoy PM] Need a token. → The token is in the vault.",
        );
      }),
    ),
  );

  it("shortens long questions in the relayed answer", () => {
    const text = relayedAnswerText("q".repeat(600), "ok", "user");
    assert.strictEqual(text, `[User answer via BusyBoy] ${"q".repeat(500)}… → ok`);
  });
});
