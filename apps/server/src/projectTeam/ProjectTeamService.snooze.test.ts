/**
 * Snoozing a waiting card ("보류"): the user sets it aside with a reason and brings it back
 * later. The card stays open, but AFK, the stall watch and the waiting count leave it alone.
 */
import { assert, describe, it } from "@effect/vitest";
import { PLAN_APPROVAL_START } from "@t3tools/contracts";
import { waitingItemKeys } from "@t3tools/shared/waitingAlerts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { StalledTaskSweep } from "./StalledTaskSweep.ts";
import {
  attentionContext,
  PROJECT_ID,
  setUpManager,
  START,
  startLead,
  writeReadyPlan,
  withTeam,
} from "./testkit.ts";

const minutes = (count: number) =>
  Effect.gen(function* () {
    const sweep = yield* StalledTaskSweep;
    for (let minute = 1; minute <= count; minute++) {
      yield* TestClock.adjust("1 minute");
      yield* sweep.sweep;
    }
  });

describe("snoozing a waiting card", () => {
  it.effect("needs a reason, leaves the count, and comes back", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = (yield* startLead(pm, "Pick a list", harness.delegate)).task.leadThreadId!;
        const { item } = yield* team.askUser(lead, {
          context: attentionContext({ action: "Which list?" }),
          kind: "decision",
          question: "Which list?\n\nFlat or grouped.",
          options: ["Flat", "Grouped (Recommended)"],
        });
        const waiting = () =>
          Effect.map(team.attentionSnapshot, (snapshot) =>
            waitingItemKeys(
              snapshot.projects.map((summary) => ({ environmentId: "env", summary })),
            ),
          );
        assert.strictEqual((yield* waiting()).total, 1);

        // No reason, no snooze.
        const empty = yield* team
          .snoozeDecision({ projectId: PROJECT_ID, attentionItemId: item.id, reason: "   " })
          .pipe(Effect.flip);
        assert.include(empty.message, "reason");

        const snoozed = yield* team.snoozeDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          reason: " 다음 주에 볼게 ",
        });
        assert.strictEqual(snoozed.item.snoozeReason, "다음 주에 볼게");
        assert.isNotNull(snoozed.item.snoozedAt ?? null);
        assert.isNull(snoozed.item.answeredAt);
        // The lead is not told anything.
        assert.isFalse(
          (yield* harness.messagesTo(lead)).some((text) => text.includes("다음 주에 볼게")),
        );

        // It leaves the count and alerts, and the PM sees it only as snoozed.
        assert.strictEqual((yield* waiting()).total, 0);
        const summary = (yield* team.attentionSnapshot).projects[0]!;
        assert.strictEqual(summary.openCount, 0);
        assert.strictEqual(summary.presence.waitingOnUser, 0);
        // The task no longer reads as waiting on the user anywhere.
        const taskRef = summary.tasks.find((task) => task.leadThreadId === lead)!;
        assert.isFalse(taskRef.openQuestion);
        const status = yield* team.teamStatus(pm, { since: START });
        assert.deepStrictEqual(status.openAttention, []);
        assert.deepStrictEqual(status.changes.newAttention, []);
        assert.deepStrictEqual(
          status.snoozedAttention.map((entry) => [entry.id, entry.title, entry.reason]),
          [[item.id, "Which list?", "다음 주에 볼게"]],
        );
        // A snoozed card can't be snoozed again over its reason.
        const twice = yield* team
          .snoozeDecision({ projectId: PROJECT_ID, attentionItemId: item.id, reason: "다른 이유" })
          .pipe(Effect.flip);
        assert.include(twice.message, "already snoozed");
        // A snoozed card doesn't hide a new permission denial from the user.
        const raised = yield* team.raisePermissionBlocker({
          threadId: lead,
          denial: { kind: "permission-rule", action: "git push", reason: null },
        });
        assert.isTrue(Option.isSome(raised));
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: Option.getOrThrow(raised).id,
          answer: "허용했어요",
        });

        // Brought back: it waits and counts again.
        const back = yield* team.unsnoozeDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
        });
        assert.isNull(back.item.snoozedAt ?? null);
        assert.isNull(back.item.snoozeReason ?? null);
        assert.strictEqual((yield* waiting()).total, 1);
        // Bringing back a card that is not snoozed is refused.
        const notSnoozed = yield* team
          .unsnoozeDecision({ projectId: PROJECT_ID, attentionItemId: item.id })
          .pipe(Effect.flip);
        assert.include(notSnoozed.message, "not snoozed");
        const again = yield* team.teamStatus(pm, {});
        assert.deepStrictEqual(
          again.openAttention.map((entry) => entry.id),
          [item.id],
        );
        assert.deepStrictEqual(again.snoozedAttention, []);

        // A closed card cannot be snoozed.
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          answer: "Flat",
        });
        const closed = yield* team
          .snoozeDecision({ projectId: PROJECT_ID, attentionItemId: item.id, reason: "나중에" })
          .pipe(Effect.flip);
        assert.include(closed.message, "closed");
      }),
    ),
  );

  it.effect("AFK never answers a snoozed card or approves a snoozed plan", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const decisionLead = (yield* startLead(pm, "Decide", harness.delegate)).task.leadThreadId!;
        const planned = yield* startLead(pm, "Plan", harness.delegate);
        const planLead = planned.task.leadThreadId!;

        const snoozedDecision = yield* team.askUser(decisionLead, {
          context: attentionContext({ action: "Which list?" }),
          kind: "decision",
          question: "Which list?",
          options: ["Flat", "Grouped (Recommended)"],
        });
        const otherDecision = yield* team.askUser(decisionLead, {
          context: attentionContext({ action: "Which color?" }),
          kind: "decision",
          question: "Which color?",
          options: ["Gray (Recommended)", "Blue"],
        });
        yield* writeReadyPlan(planLead);
        const plan = yield* team.askUser(planLead, {
          context: attentionContext({ action: "Approve the plan?" }),
          kind: "approval",
          question: "Approve the plan?",
        });
        for (const item of [snoozedDecision.item, plan.item]) {
          yield* team.snoozeDecision({
            projectId: PROJECT_ID,
            attentionItemId: item.id,
            reason: "주말에 볼게",
          });
        }

        yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
        yield* TestClock.adjust("10 minutes");
        yield* team.afkSweep;

        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const read = (id: typeof plan.item.id) =>
          Effect.map(repository.getAttentionItem(id), Option.getOrThrow);
        assert.isNull((yield* read(snoozedDecision.item.id)).answeredAt);
        assert.isNull((yield* read(plan.item.id)).answeredAt);
        assert.strictEqual(
          (yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: planned.task.id })).task
            .stage,
          "awaiting_approval",
        );
        // The unsnoozed card is still answered for the user.
        assert.strictEqual((yield* read(otherDecision.item.id)).answeredBy, "afk");

        // Brought back, AFK handles the plan again.
        yield* team.unsnoozeDecision({ projectId: PROJECT_ID, attentionItemId: plan.item.id });
        yield* team.afkSweep;
        assert.strictEqual((yield* read(plan.item.id)).answer, PLAN_APPROVAL_START);
      }),
    ),
  );

  it.effect("the stall watch leaves a task with a snoozed card alone", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Waiting lead", harness.delegate);
        const lead = started.task.leadThreadId!;
        harness.addThread(lead);
        const { item } = yield* team.askUser(lead, {
          context: attentionContext({ action: "Which list?" }),
          kind: "decision",
          question: "Which list?",
          options: ["Flat", "Grouped (Recommended)"],
        });
        yield* team.snoozeDecision({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          reason: "다음 주에 볼게",
        });

        yield* minutes(45);

        // No wake for the lead, no restart card, and no avoidable stall time.
        assert.isFalse(
          (yield* harness.messagesTo(lead)).some((text) => text.startsWith("[자동 재개]")),
        );
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const open = yield* repository.listOpenAttentionItems({
          projectId: PROJECT_ID,
          taskId: started.task.id,
        });
        assert.deepStrictEqual(
          open.map((entry) => entry.id),
          [item.id],
        );
        const task = Option.getOrThrow(yield* repository.getTask(started.task.id));
        assert.deepStrictEqual(task.metrics.avoidableStallMs ?? {}, {});
      }),
    ),
  );
});
