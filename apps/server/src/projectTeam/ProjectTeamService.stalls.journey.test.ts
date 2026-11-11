/**
 * Replays the four ways tasks sat still unnoticed on 2026-11-10 and 11, and checks
 * that each now moves again or reaches the user within minutes:
 *
 * 1. A stop said only in chat ("wait until the team pin ends") that nobody undid.
 * 2. A cloud lead that failed at once because the cloud had no Claude token.
 * 3. A lead that stopped without finishing, asking or holding.
 * 4. A lead that got the user's answer and stayed put for over 30 minutes.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  isStallBlocker,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectTask,
  ProjectTaskEventId,
  ProviderThreadId,
  RunId,
  STALL_RESTART,
  type ThreadId,
} from "@t3tools/contracts";
import { requestMessageProblems } from "@t3tools/shared/requestMessage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { nowIso } from "./common.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { StalledTaskSweep } from "./StalledTaskSweep.ts";
import { CLOUD_PINNED_NOTE } from "./startFailure.ts";
import * as TaskOutcomeReactor from "./taskOutcomeReactor.ts";
import {
  attentionContext,
  createAcceptedTask,
  setUpManager,
  startLead,
  type TeamHarness,
  withTeam,
} from "./testkit.ts";

const MINUTE = 60_000;

const minutes = (count: number) =>
  Effect.gen(function* () {
    const sweep = yield* StalledTaskSweep;
    for (let minute = 1; minute <= count; minute++) {
      yield* TestClock.adjust("1 minute");
      yield* sweep.sweep;
    }
  });

const readTask = (task: Pick<ProjectTask, "id">) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.getTask(task.id).pipe(Effect.map(Option.getOrThrow)),
  );

const openCards = (task: Pick<ProjectTask, "id" | "projectId">) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.listOpenAttentionItems({ projectId: task.projectId, taskId: task.id }),
  );

const nowMs = Effect.map(nowIso, Date.parse);

const failedRun = (lead: ThreadId, at: DateTime.Utc): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(`event-${lead}-failed`),
    threadId: lead,
    occurredAt: at,
    type: "run.updated",
    payload: {
      id: RunId.make(`run:${lead}:1`),
      threadId: lead,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("claude"),
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${lead}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "failed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  }) as OrchestrationV2DomainEvent;

const NO_TOKEN = "Cloud lead could not start: claude_oauth_token is not saved for the cloud.";

/** A started lead placed in the cloud, whose first turn fails with the given error. */
const cloudLeadFailsToStart = (
  harness: TeamHarness,
  pm: ThreadId,
  title: string,
  options: { readonly pinned?: boolean } = {},
) =>
  Effect.gen(function* () {
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const reactor = yield* TaskOutcomeReactor.TaskOutcomeReactor;
    const started = yield* startLead(pm, title, harness.delegate);
    const lead = started.task.leadThreadId!;
    yield* repository.setTaskMove({
      id: started.task.id,
      moveTarget: null,
      location: "cloud",
      now: yield* nowIso,
    });
    const thread = harness.addThread(lead);
    thread.worktreePath = `/data/worktrees/${title}`;
    thread.providerThreads = [
      {
        id: ProviderThreadId.make(`provider-${title}`),
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeThreadRef: null,
      },
    ];
    thread.shell = {
      location: "cloud",
      activeProviderThreadId: ProviderThreadId.make(`provider-${title}`),
      lastError: NO_TOKEN,
    };
    if (options.pinned === true) {
      // What task_start logs when the PM asks for the cloud on purpose.
      yield* repository.appendTaskEvent({
        id: ProjectTaskEventId.make(`task-event:pinned:${title}`),
        projectId: started.task.projectId,
        taskId: started.task.id,
        kind: "note",
        body: CLOUD_PINNED_NOTE,
        actorThreadId: null,
        createdAt: yield* nowIso,
      });
    }
    yield* reactor.handle(failedRun(lead, yield* DateTime.now));
    return { task: started.task, lead };
  });

describe("stall journey", () => {
  it.effect("refuses a stop without a resume condition", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const started = yield* startLead(pm, "Team pin follow-up", harness.delegate);

        const refused = yield* team
          .updateTask(pm, { taskId: started.task.id, stage: "inbox" })
          .pipe(Effect.flip);
        assert.include(refused.message, "needs a resume condition");
        assert.strictEqual((yield* readTask(started.task)).stage, "planning");
      }),
    ),
  );

  it.effect("a time condition tells the PM to start the task once the time comes", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const { task } = yield* createAcceptedTask(pm, {
          title: "Night job",
          request: "Night job.",
          intake: "New work.",
        });
        const at = new Date((yield* nowMs) + 30 * MINUTE).toISOString();
        yield* team.updateTask(pm, {
          taskId: task.id,
          hold: { resumeWhen: { type: "time", at }, reason: "Run after the release." },
        });
        yield* minutes(29);
        assert.isFalse(
          (yield* harness.messagesTo(pm)).some((text) => text.includes("resume condition is met")),
        );
        yield* minutes(1);
        assert.isTrue(
          (yield* harness.messagesTo(pm)).some(
            (text) => text.includes(`resume condition is met`) && text.includes(task.id),
          ),
        );
        assert.isNull((yield* readTask(task)).hold ?? null);
      }),
    ),
  );

  it.effect("a Todo task that could start reaches the PM at 10 minutes and the user at 20", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const { task } = yield* createAcceptedTask(pm, {
          title: "Forgotten",
          request: "Forgotten.",
          intake: "New work.",
        });
        // The first pass sees it could start; the clock runs from there.
        yield* minutes(1);
        yield* minutes(9);
        assert.isFalse(
          (yield* harness.messagesTo(pm)).some((text) => text.includes("could start")),
        );
        yield* minutes(1);
        assert.isTrue((yield* harness.messagesTo(pm)).some((text) => text.includes("could start")));
        yield* minutes(10);
        const cards = yield* openCards(task);
        assert.strictEqual(cards.length, 1);
        assert.isTrue(isStallBlocker(cards[0]!));
        assert.strictEqual(cards[0]!.askerThreadId, pm);
        assert.deepStrictEqual(requestMessageProblems(cards[0]!.question, cards[0]!.details), []);
        assert.strictEqual(
          (yield* readTask(task)).metrics.avoidableStallMs?.not_started,
          20 * MINUTE,
        );
      }),
    ),
  );

  it.effect("a cloud lead that cannot start moves to this Mac under local first", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const { task, lead } = yield* cloudLeadFailsToStart(harness, pm, "Build speed");

          const moved = yield* readTask(task);
          assert.strictEqual(moved.location, "local");
          assert.notStrictEqual(moved.stage, "blocked");
          assert.isTrue((yield* harness.messagesTo(lead)).some((text) => text.includes("[옮김]")));
          assert.deepStrictEqual(yield* openCards(task), []);
        }),
      { settings: { taskExecution: { location: "local_first" } } },
    ),
  );

  it.effect("a cloud lead pinned to the cloud names the missing token at once", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const { task } = yield* cloudLeadFailsToStart(harness, pm, "Build speed", {
            pinned: true,
          });
          const cards = yield* openCards(task);
          assert.strictEqual(cards.length, 1);
          const card = cards[0]!;
          assert.isTrue(isStallBlocker(card));
          assert.deepStrictEqual(card.options, [STALL_RESTART]);
          assert.strictEqual(
            card.question.split("\n")[0],
            "클라우드 로그인 토큰이 없어 Build speed 리드를 시작하지 못했어요",
          );
          assert.deepStrictEqual(requestMessageProblems(card.question), []);
          assert.isTrue(card.details?.some((detail) => detail.text.includes("claude_oauth_token")));
          const blocked = yield* readTask(task);
          assert.strictEqual(blocked.stage, "blocked");
          assert.strictEqual(blocked.location, "cloud");
        }),
      { settings: { taskExecution: { location: "local_first" } } },
    ),
  );

  it.effect("replays today: each stall moves again or reaches the user within 20 minutes", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          const record: Array<string> = [];

          // 1. The Director says "wait until the team pin ends"; the PM must say so in structure.
          const pin = yield* startLead(pm, "Team pin", harness.delegate);
          harness.addThread(pin.task.leadThreadId!).activeRunId = "run-pin";
          const { task: waiting } = yield* createAcceptedTask(pm, {
            title: "After the pin",
            request: "After the pin.",
            intake: "New work.",
          });
          yield* team.updateTask(pm, {
            taskId: waiting.id,
            hold: {
              resumeWhen: { type: "task", taskId: pin.task.id },
              reason: "Director: wait until the team pin ends.",
            },
          });
          yield* minutes(15);
          assert.isFalse(
            (yield* harness.messagesTo(pm)).some((text) =>
              text.includes("resume condition is met"),
            ),
          );
          harness.threads.get(pin.task.leadThreadId!)!.activeRunId = null;
          yield* team.updateTask(pin.task.leadThreadId!, { stage: "cancelled" });
          const pinEndedAt = yield* nowMs;
          yield* minutes(1);
          assert.isTrue(
            (yield* harness.messagesTo(pm)).some(
              (text) => text.includes("resume condition is met") && text.includes(waiting.id),
            ),
          );
          record.push(`hold: PM told ${((yield* nowMs) - pinEndedAt) / MINUTE} min after`);

          // 2. A cloud lead fails at once for a missing token (local first: moves here).
          const cloud = yield* cloudLeadFailsToStart(harness, pm, "Cloud work");
          assert.strictEqual((yield* readTask(cloud.task)).location, "local");
          record.push("cloud start failure: moved to this Mac in the same pass");

          // 3. A lead stops without finishing, asking or holding.
          const quiet = yield* startLead(pm, "Quiet lead", harness.delegate);
          harness.addThread(quiet.task.leadThreadId!);
          const quietSince = yield* nowMs;
          yield* minutes(20);
          assert.strictEqual((yield* openCards(quiet.task)).length, 1);
          record.push(`no progress: user told ${((yield* nowMs) - quietSince) / MINUTE} min after`);

          // 4. The user answers, and the lead does not pick it up.
          const answered = yield* startLead(pm, "Answered lead", harness.delegate);
          const answeredLead = answered.task.leadThreadId!;
          harness.addThread(answeredLead);
          const { item } = yield* team.askUser(answeredLead, {
            context: attentionContext({ action: "Pick one" }),
            kind: "decision",
            question: "Pick one",
            options: ["A (Recommended)", "B"],
          });
          yield* team.answerDecision({
            projectId: item.projectId,
            attentionItemId: item.id,
            answer: "A (Recommended)",
          });
          const answeredAt = yield* nowMs;
          yield* minutes(20);
          assert.strictEqual((yield* openCards(answered.task)).length, 1);
          assert.isTrue(
            (yield* harness.messagesTo(answeredLead)).some((text) =>
              text.startsWith("[답 다시 전달]"),
            ),
          );
          record.push(
            `answered idle: user told ${((yield* nowMs) - answeredAt) / MINUTE} min after`,
          );

          assert.deepStrictEqual(record, [
            "hold: PM told 1 min after",
            "cloud start failure: moved to this Mac in the same pass",
            "no progress: user told 20 min after",
            "answered idle: user told 20 min after",
          ]);
          const quietTask = yield* readTask(quiet.task);
          const answeredTask = yield* readTask(answered.task);
          assert.strictEqual(quietTask.metrics.avoidableStallMs?.no_progress, 20 * MINUTE);
          assert.strictEqual(answeredTask.metrics.avoidableStallMs?.answered_idle, 20 * MINUTE);
        }),
      { settings: { taskExecution: { location: "local_first" } } },
    ),
  );
});
