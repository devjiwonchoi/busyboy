import { assert, describe, it } from "@effect/vitest";
import { isStallBlocker, type ProjectTask, STALL_RESTART } from "@t3tools/contracts";
import { requestMessageProblems } from "@t3tools/shared/requestMessage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { nowIso } from "./common.ts";
import { StalledTaskSweep } from "./StalledTaskSweep.ts";
import { attentionContext, setUpManager, startLead, withTeam } from "./testkit.ts";

const minutes = (count: number) =>
  Effect.gen(function* () {
    const sweep = yield* StalledTaskSweep;
    for (let minute = 1; minute <= count; minute++) {
      yield* TestClock.adjust("1 minute");
      yield* sweep.sweep;
    }
  });

const openCards = (task: ProjectTask) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.listOpenAttentionItems({ projectId: task.projectId, taskId: task.id }),
  );

const readTask = (task: ProjectTask) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.getTask(task.id).pipe(Effect.map(Option.getOrThrow)),
  );

const isWake = (text: string) => text.startsWith("[자동 재개]");

describe("StalledTaskSweep", () => {
  it.effect("wakes a stalled lead once at 10 minutes and messages the user once at 20", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Login redirect", harness.delegate);
        harness.addThread(started.task.leadThreadId!);
        const lead = started.task.leadThreadId!;

        yield* minutes(9);
        assert.deepStrictEqual((yield* harness.messagesTo(lead)).filter(isWake), []);

        yield* minutes(1);
        assert.strictEqual((yield* harness.messagesTo(lead)).filter(isWake).length, 1);
        assert.deepStrictEqual(yield* openCards(started.task), []);

        yield* minutes(10);
        const cards = yield* openCards(started.task);
        assert.strictEqual(cards.length, 1);
        const card = cards[0]!;
        assert.isTrue(isStallBlocker(card));
        assert.deepStrictEqual(card.options, [STALL_RESTART]);
        assert.strictEqual(card.askerThreadId, lead);
        assert.deepStrictEqual(requestMessageProblems(card.question, card.details), []);
        assert.include(card.question.split("\n")[0], "20분째 멈춰 있어요");

        // One wake and one message per stall, however long it lasts.
        yield* minutes(15);
        assert.strictEqual((yield* harness.messagesTo(lead)).filter(isWake).length, 1);
        assert.strictEqual((yield* openCards(started.task)).length, 1);

        // The card is a wait on the user: the stall ended when it opened, at 20 minutes.
        const task = yield* readTask(started.task);
        assert.strictEqual(task.metrics.avoidableStallMs?.no_progress, 20 * 60_000);
      }),
    ),
  );

  it.effect("does not count a wait on the user, a lead at work, or a memory hold", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const asking = yield* startLead(pm, "Asking", harness.delegate);
        const busy = yield* startLead(pm, "Busy", harness.delegate);
        const memory = yield* startLead(pm, "Memory", harness.delegate);
        for (const started of [asking, busy, memory]) {
          harness.addThread(started.task.leadThreadId!);
        }
        yield* team.askUser(asking.task.leadThreadId!, {
          context: attentionContext({ action: "Pick one" }),
          kind: "decision",
          question: "Pick one",
          options: ["A (Recommended)", "B"],
        });
        harness.threads.get(busy.task.leadThreadId!)!.activeRunId = "run-busy";
        yield* repository.setTaskMemoryHold({
          id: memory.task.id,
          memoryHold: "paused",
          now: yield* nowIso,
        });

        yield* minutes(30);
        for (const started of [asking, busy, memory]) {
          const lead = started.task.leadThreadId!;
          assert.deepStrictEqual((yield* harness.messagesTo(lead)).filter(isWake), []);
          const task = yield* readTask(started.task);
          assert.deepStrictEqual(task.metrics.avoidableStallMs ?? {}, {});
          assert.deepStrictEqual(yield* repository.listOpenTaskStalls({ taskId: task.id }), []);
        }
      }),
    ),
  );

  it.effect("sends an answer again when the lead never picked it up, then wakes and messages", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Answered", harness.delegate);
        const lead = started.task.leadThreadId!;
        const thread = harness.addThread(lead);
        const { item } = yield* team.askUser(lead, {
          context: attentionContext({ action: "Pick one" }),
          kind: "decision",
          question: "Pick one",
          options: ["A (Recommended)", "B"],
        });
        // The lead's last turn ended when it asked.
        thread.shell = { latestRunCompletedAt: yield* DateTime.now };
        yield* minutes(5);
        yield* team.answerDecision({
          projectId: item.projectId,
          attentionItemId: item.id,
          answer: "A (Recommended)",
        });

        yield* minutes(2);
        const redelivered = (yield* harness.messagesTo(lead)).filter((text) =>
          text.startsWith("[답 다시 전달]"),
        );
        assert.strictEqual(redelivered.length, 1);
        assert.include(redelivered[0]!, "A (Recommended)");

        yield* minutes(8);
        const wakes = (yield* harness.messagesTo(lead)).filter(isWake);
        assert.strictEqual(wakes.length, 1);
        assert.include(wakes[0]!, "사용자의 답을 받은 뒤");

        yield* minutes(10);
        const cards = yield* openCards(started.task);
        assert.strictEqual(cards.length, 1);
        assert.include(cards[0]!.question.split("\n")[0], "답을 받고도 20분째");
        assert.deepStrictEqual(requestMessageProblems(cards[0]!.question, cards[0]!.details), []);
        const task = yield* readTask(started.task);
        assert.strictEqual(task.metrics.avoidableStallMs?.answered_idle, 20 * 60_000);
        assert.strictEqual(
          (yield* harness.messagesTo(lead)).filter((text) => text.startsWith("[답 다시 전달]"))
            .length,
          1,
        );
      }),
    ),
  );

  it.effect("stays quiet while the PM is turned off", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Slow", harness.delegate);
        harness.addThread(started.task.leadThreadId!);
        yield* team.updateSettings({ projectId: started.task.projectId, enabled: false });

        yield* minutes(25);
        assert.deepStrictEqual(
          (yield* harness.messagesTo(started.task.leadThreadId!)).filter(isWake),
          [],
        );
        assert.deepStrictEqual(yield* openCards(started.task), []);
      }),
    ),
  );
});
