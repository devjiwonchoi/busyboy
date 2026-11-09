import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { dismissedQuestionText, relayedAnswerText } from "./AttentionRouter.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  attentionContext,
  PROJECT_ID,
  setUpManager,
  startLead,
  userSays,
  withTeam,
} from "./testkit.ts";

describe("AttentionRouter", () => {
  it.effect("preserves approval context in task detail and the shared attention feed", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const context = {
          action: "수정 사항을 병합하고 배포합니다",
          reason: "로그인 오류를 사용자에게 전달하려면 배포가 필요합니다.",
          impacts: ["merge", "deploy", "cost", "publish"] as const,
          cost: "호스팅 요금은 사용량에 따라 달라 아직 확정할 수 없습니다.",
          reversibility: "requires_work" as const,
          recommendation: "검증한 수정 사항을 병합한 뒤 배포하는 안을 추천합니다.",
        };
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "decision",
          question: "로그인 수정 사항을 병합하고 배포할까요?",
          context,
        });
        assert.deepStrictEqual(item.context, context);
        const card = (yield* team.attentionSnapshot).projects
          .flatMap((project) => project.decisionCards)
          .find((entry) => entry.item.id === item.id);
        assert.deepStrictEqual(card?.item.context, context);
        const detail = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: lead.task.id });
        assert.deepStrictEqual(
          detail.openAttention.find((entry) => entry.id === item.id)?.context,
          context,
        );
      }),
    ),
  );

  it.effect("closes a task's open cards when it is cancelled or done", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const cancelled = yield* startLead(pm, "Group sidebar tasks", harness.delegate);
        const finished = yield* startLead(pm, "Hello", harness.delegate);
        const kept = yield* startLead(pm, "Goodbye", harness.delegate);
        const first = yield* team.askUser(cancelled.leadThreadId, {
          context: attentionContext({ action: "Which login provider?" }),
          kind: "decision",
          question: "Which login provider?",
        });
        yield* team.askUser(cancelled.leadThreadId, {
          context: attentionContext({ action: "Which?" }),
          kind: "decision",
          question: "Which?",
        });
        yield* team.askUser(finished.leadThreadId, {
          context: attentionContext({ action: "Token?" }),
          kind: "blocker",
          question: "Token?",
        });
        const open = yield* team.askUser(kept.leadThreadId, {
          context: attentionContext({ action: "A?" }),
          kind: "decision",
          question: "A?",
        });
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
          .answerAttention(pm, { attentionItemId: first.item.id, answer: "Yes." })
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
          context: attentionContext({ action: "Plan A?" }),
          kind: "decision",
          question: "Plan A?",
        });
        yield* TestClock.adjust("1 minute");
        const second = yield* team.askUser(b.leadThreadId, {
          context: attentionContext({ action: "Plan B?" }),
          kind: "decision",
          question: "Plan B?",
        });
        yield* TestClock.adjust("90 seconds");
        const third = yield* team.askUser(a.leadThreadId, {
          context: attentionContext({ action: "Tabs or spaces?" }),
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
          context: attentionContext({ action: "Need a token." }),
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
          context: attentionContext({ action: "Ship the fix today?" }),
          kind: "decision",
          question: "Ship the fix today?",
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
          "[User's chat answer, relayed by BusyBoy PM] Ship the fix today? → Yes, go ahead.",
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

  it.effect("lets the PM close a moot question and tells the lead that asked", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          context: attentionContext({ action: "Ship the fix today?" }),
          kind: "decision",
          question: "Ship the fix today?",
        });
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 1);

        const dismissed = yield* team.dismissAttention(pm, {
          attentionItemId: item.id,
          reason: "The user decided to ship tomorrow",
        });
        assert.isNotNull(dismissed.item.supersededAt);
        assert.isNull(dismissed.item.answer);
        assert.isNull(dismissed.item.answeredAt);
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 0);
        const [notice] = yield* Ref.get(harness.sent);
        assert.strictEqual(notice?.threadId, lead.leadThreadId);
        assert.strictEqual(notice?.senderThreadId, pm);
        assert.strictEqual(
          notice?.text,
          dismissedQuestionText("Ship the fix today?", "The user decided to ship tomorrow"),
        );
        assert.include(notice?.text ?? "", "[Question closed by BusyBoy PM]");
        const task = yield* team.readTask(pm, { taskId: lead.task.id });
        assert.include(
          task.events.map((event) => event.body),
          "Question closed: The user decided to ship tomorrow",
        );

        const again = yield* team
          .dismissAttention(pm, { attentionItemId: item.id, reason: "Again" })
          .pipe(Effect.flip);
        assert.include(again.message, "is closed");
        const answer = yield* team
          .answerAttention(pm, { attentionItemId: item.id, answer: "Yes." })
          .pipe(Effect.flip);
        assert.include(answer.message, "it was dismissed");
      }),
    ),
  );

  it.effect("lets a lead withdraw only its own open question", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const asker = yield* startLead(pm, "Hello", harness.delegate);
        const other = yield* startLead(pm, "Goodbye", harness.delegate);
        const own = yield* team.askUser(asker.leadThreadId, {
          context: attentionContext({ action: "Tabs or spaces?" }),
          kind: "decision",
          question: "Tabs or spaces?",
        });
        const answered = yield* team.askUser(asker.leadThreadId, {
          context: attentionContext({ action: "Need a token." }),
          kind: "blocker",
          question: "Need a token.",
        });
        yield* team.answerAttention(pm, { attentionItemId: answered.item.id, answer: "Done." });
        const sentBefore = (yield* Ref.get(harness.sent)).length;

        const refused = yield* team
          .dismissAttention(other.leadThreadId, {
            attentionItemId: own.item.id,
            reason: "Not needed",
          })
          .pipe(Effect.flip);
        assert.include(refused.message, "only close its own questions");

        const closedAnswered = yield* team
          .dismissAttention(asker.leadThreadId, {
            attentionItemId: answered.item.id,
            reason: "Not needed",
          })
          .pipe(Effect.flip);
        assert.include(closedAnswered.message, "already answered");

        const withdrawn = yield* team.dismissAttention(asker.leadThreadId, {
          attentionItemId: own.item.id,
          reason: "Found the style guide",
        });
        assert.isNotNull(withdrawn.item.supersededAt);
        assert.isNull(withdrawn.item.answer);
        assert.strictEqual((yield* Ref.get(harness.sent)).length, sentBefore);
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 0);
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
          context: attentionContext({ action: "Ship the fix today?" }),
          kind: "decision",
          question: "Ship the fix today?",
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

  it.effect("sends a card answer straight to the task lead without waking the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fix login", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          context: attentionContext({ action: "Ship the fix today?" }),
          kind: "decision",
          question: "Ship the fix today?",
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
          "[User answer via BusyBoy] Ship the fix today? → Approve\nNote: keep it small",
        );
        const summary = (yield* team.attentionSnapshot).projects[0];
        assert.strictEqual(summary?.openCount, 0);
        assert.strictEqual(summary?.decisionCards[0]?.item.answer, "Approve\nNote: keep it small");
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);
      }),
    ),
  );

  it.effect("relays a typed answer outside the options to the task lead as written", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fix login", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          context: attentionContext({ action: "Keep the remaining runs?" }),
          kind: "decision",
          question: "Keep the remaining runs?",
          options: ["A: keep them", "B: cancel them"],
        });

        const answered = yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: "우선 원인부터 찾아보자",
        });
        assert.strictEqual(answered.item.answer, "우선 원인부터 찾아보자");
        const toLead = (yield* Ref.get(harness.sent)).filter(
          (relay) => relay.threadId === lead.leadThreadId,
        );
        assert.deepStrictEqual(
          toLead.map((relay) => relay.text),
          ["[User answer via BusyBoy] Keep the remaining runs? → 우선 원인부터 찾아보자"],
        );
      }),
    ),
  );

  it.effect("rejects a PM answer on a decision card the user did not write", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Hello", harness.delegate);
        // Written before the card appeared, so it cannot answer it.
        userSays(harness, pm, "Use Postgres", { id: "early" });
        yield* TestClock.adjust("1 minute");
        const database = yield* team.askUser(lead.leadThreadId, {
          context: attentionContext({ action: "Which database?" }),
          kind: "decision",
          question: "Which database?",
          options: ["Use Postgres", "Use SQLite"],
        });
        const decision = yield* team.askUser(lead.leadThreadId, {
          context: attentionContext({ action: "Tabs or spaces?" }),
          kind: "decision",
          question: "Tabs or spaces?",
          options: ["tabs", "spaces"],
        });
        const later = "2026-11-04T00:02:00.000Z";
        // An agent or the server writing as the user does not count either.
        userSays(harness, pm, "Use Postgres", {
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
          [database.item, "Use Postgres"],
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
          context: attentionContext({ action: "Ship the fix today?" }),
          kind: "decision",
          question: "Ship the fix today?",
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
          "[User's chat answer, relayed by BusyBoy PM] Ship the fix today? →  전부 승인 ",
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
          context: attentionContext({ action: "Need a token." }),
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
