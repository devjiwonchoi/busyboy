import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectTeamQuietHours,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { isWithinQuietHours, SitrepScheduler } from "./SitrepScheduler.ts";
import {
  assistantMessage,
  PROJECT_ID,
  setUpManager,
  START,
  startLead,
  type TeamHarness,
  withTeam,
} from "./testkit.ts";

const sitrepRequests = (harness: TeamHarness, pm: ThreadId) =>
  harness
    .messagesTo(pm)
    .pipe(Effect.map((texts) => texts.filter((text) => text.startsWith("[Sitrep due]"))));

const latestSitrepRequest = (harness: TeamHarness, pm: ThreadId) =>
  Effect.gen(function* () {
    const request = (yield* Ref.get(harness.dispatched))
      .filter((command) => command.type === "message.dispatch" && command.threadId === pm)
      .at(-1);
    assert(request?.type === "message.dispatch");
    return { messageId: request.messageId, runId: `run-${request.messageId}` };
  });

/** The PM writes one message in its sitrep turn, at the current test time. */
const writeInSitrepTurn = (harness: TeamHarness, pm: ThreadId, text: string) =>
  Effect.gen(function* () {
    const { runId } = yield* latestSitrepRequest(harness, pm);
    const thread = harness.threads.get(pm)!;
    const now = DateTime.formatIso(yield* DateTime.now);
    thread.messages.push(
      assistantMessage({
        threadId: pm,
        runId,
        text,
        id: `message:${runId}:${thread.messages.length}`,
        createdAt: now,
      }),
    );
  });

/** Ends the PM's turn for the latest sitrep request. */
const finishSitrepTurn = (harness: TeamHarness, pm: ThreadId) =>
  Effect.gen(function* () {
    const sitreps = yield* SitrepScheduler;
    const { messageId, runId } = yield* latestSitrepRequest(harness, pm);
    yield* sitreps.handle({
      id: EventId.make(`event-${runId}`),
      threadId: pm,
      occurredAt: DateTime.makeUnsafe(START),
      type: "run.updated",
      payload: { id: runId, threadId: pm, status: "completed", userMessageId: messageId },
    } as unknown as OrchestrationV2DomainEvent);
  });

/** Ends the PM's turn for the latest sitrep request with the given text. */
const postSitrep = (harness: TeamHarness, pm: ThreadId, text: string) =>
  Effect.gen(function* () {
    yield* writeInSitrepTurn(harness, pm, text);
    yield* finishSitrepTurn(harness, pm);
  });

const userMessage = (pm: ThreadId, at: string): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(`event-user-${at}`),
    threadId: pm,
    occurredAt: DateTime.makeUnsafe(at),
    type: "message.updated",
    payload: {
      id: MessageId.make(`user-${at}`),
      threadId: pm,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text: "hi",
      createdAt: DateTime.makeUnsafe(at),
    },
  }) as unknown as OrchestrationV2DomainEvent;

describe("SitrepScheduler", () => {
  it.effect("folds milestones into one sitrep once the interval has passed", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const a = yield* startLead(pm, "Hello", harness.delegate);
        const b = yield* startLead(pm, "Goodbye", harness.delegate);

        yield* team.updateTask(a.leadThreadId, { stage: "done", resultSummary: "Added hello.sh." });
        yield* TestClock.adjust("1 minute");
        yield* sitreps.check;
        yield* team.updateTask(b.leadThreadId, {
          stage: "done",
          resultSummary: "Added goodbye.sh.",
        });
        // Finished tasks do not cut the 60-minute interval short.
        for (let minute = 2; minute < 60; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
        }
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

        yield* TestClock.adjust("1 minute");
        yield* sitreps.check;
        const requests = yield* sitrepRequests(harness, pm);
        assert.deepStrictEqual(requests, [
          "[Sitrep due] since 2026-11-04T00:00:00.000Z. Call team_status(since) and post a 3–6 line sitrep.",
        ]);
        const snapshot = yield* team.attentionSnapshot;
        assert.strictEqual(snapshot.projects[0]?.sitrepInProgress, true);
        assert.strictEqual(snapshot.projects[0]?.latestSitrepId, null);

        yield* postSitrep(harness, pm, "#1 and #2 are done.");
        const posted = (yield* team.attentionSnapshot).projects[0];
        assert.strictEqual(posted?.sitrepInProgress, false);
        assert.strictEqual(posted?.unreadSitrepCount, 1);
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const latest = Option.getOrThrow(yield* repository.getLatestSitrep(PROJECT_ID));
        assert.strictEqual(latest.body, "#1 and #2 are done.");
        assert.strictEqual(latest.reason, "milestone");
        assert.strictEqual(posted?.latestSitrepId, latest.id);
      }),
    ),
  );

  it.effect("sends no sitreps while the PM is turned off and resumes when it is back on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        yield* team.updateSettings({ projectId: PROJECT_ID, enabled: false });
        yield* TestClock.adjust("1 minute");
        yield* startLead(pm, "Long job", harness.delegate);
        yield* TestClock.adjust("60 minutes");
        yield* sitreps.check;
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

        yield* team.updateSettings({ projectId: PROJECT_ID, enabled: true });
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
      }),
    ),
  );

  it.effect("sends interval sitreps only when something changed", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        yield* TestClock.adjust("61 minutes");
        yield* sitreps.check;
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

        yield* startLead(pm, "Long job", harness.delegate);
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
        yield* postSitrep(harness, pm, "#1 is planning.");

        yield* TestClock.adjust("61 minutes");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);

        // A task still running with nothing new is not worth a sitrep.
        yield* TestClock.adjust("60 minutes");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
      }),
    ),
  );

  it.effect("waits while the user is talking to the PM or the PM is running", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        yield* sitreps.noteMilestone(PROJECT_ID);
        yield* TestClock.adjust("59 minutes");
        yield* sitreps.handle(userMessage(pm, "2026-11-04T00:59:00.000Z"));
        yield* TestClock.adjust("1 minute");
        yield* sitreps.check;
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

        yield* TestClock.adjust("2 minutes");
        harness.threads.get(pm)!.activeRunId = "run-pm";
        yield* sitreps.check;
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

        harness.threads.get(pm)!.activeRunId = null;
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
      }),
    ),
  );

  it.effect("never changes the interval when the PM checks progress while chatting", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        yield* TestClock.adjust("1 minute");
        yield* team.teamStatus(pm, {});
        yield* TestClock.adjust("40 minutes");
        const status = yield* team.teamStatus(pm, {});
        assert.strictEqual(status.settings.sitrepIntervalMinutes, 60);
        const events = yield* repository.listProjectEventsSince({
          projectId: PROJECT_ID,
          since: "2026-11-04T00:00:00.000Z" as never,
        });
        assert.isFalse(events.some((event) => event.kind === "preference_changed"));
      }),
    ),
  );

  it.effect("halves an interval the user never set once per window on Sitrep now", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const interval = team
          .teamStatus(pm, {})
          .pipe(Effect.map((status) => status.settings.sitrepIntervalMinutes));
        yield* TestClock.adjust("1 minute");
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.strictEqual(yield* interval, 30);
        yield* postSitrep(harness, pm, "All quiet.");
        yield* TestClock.adjust("1 minute");
        // A second press right after the sitrep is not "before the next one was due".
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.strictEqual(yield* interval, 30);
        yield* postSitrep(harness, pm, "Still quiet.");

        yield* TestClock.adjust("16 minutes");
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.strictEqual(yield* interval, 15);
        const requests = yield* sitrepRequests(harness, pm);
        assert.include(
          requests[0],
          "Mention: interval changed to 30 min because you asked for a sitrep before the next one was due",
        );
      }),
    ),
  );

  it.effect("waits a full interval after an empty sitrep instead of asking again", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        yield* TestClock.adjust("1 minute");
        yield* startLead(pm, "Long job", harness.delegate);
        yield* TestClock.adjust("60 minutes");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
        yield* postSitrep(harness, pm, "   ");
        const latest = Option.getOrThrow(yield* repository.getLatestSitrep(PROJECT_ID));
        assert.strictEqual(latest.body, "(No sitrep was posted.)");
        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.strictEqual(manager.lastSitrepAt, null);
        assert.strictEqual(manager.unreadSitrepStreak, 0);

        for (let minute = 1; minute <= 59; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
        }
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
        yield* TestClock.adjust("1 minute");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 2);
      }),
    ),
  );

  it.effect("ends the window at the sitrep request so changes during the turn count next", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        const requestedAt = Option.getOrThrow(
          yield* repository.getLatestSitrep(PROJECT_ID),
        ).createdAt;
        yield* TestClock.adjust("1 minute");
        yield* startLead(pm, "Mid-turn", harness.delegate);
        yield* TestClock.adjust("1 minute");
        yield* postSitrep(harness, pm, "All quiet.");
        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.strictEqual(manager.lastSitrepAt, requestedAt);

        yield* TestClock.adjust("30 minutes");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 2);
      }),
    ),
  );

  it.effect("gives up on a sitrep the PM never wrote so sitreps resume", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const first = yield* team.requestSitrep({ projectId: PROJECT_ID });
        yield* TestClock.adjust("29 minutes");
        assert.strictEqual(
          (yield* team.requestSitrep({ projectId: PROJECT_ID })).sitrepId,
          first.sitrepId,
        );

        yield* TestClock.adjust("2 minutes");
        const second = yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.notStrictEqual(second.sitrepId, first.sitrepId);
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 2);

        // A replaced PM thread will never post the sitrep the old one was asked for.
        harness.threads.get(pm)!.deletedAt = "2026-11-04T00:31:00.000Z";
        yield* team.ensureManager(PROJECT_ID);
        const latest = Option.getOrThrow(yield* repository.getLatestSitrep(PROJECT_ID));
        assert.strictEqual(latest.id, second.sitrepId);
        assert.strictEqual(latest.body, "(No sitrep was posted.)");
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.sitrepInProgress, false);
      }),
    ),
  );

  it.effect("doubles the interval after three unanswered sitreps", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        for (let i = 0; i < 3; i++) {
          yield* sitreps.noteMilestone(PROJECT_ID);
          yield* TestClock.adjust("60 minutes");
          yield* sitreps.check;
          yield* postSitrep(harness, pm, `Sitrep ${i}`);
        }
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 3);
        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.strictEqual(manager.settings.sitrepIntervalMinutes, 120);
        assert.strictEqual(manager.unreadSitrepStreak, 0);
      }),
    ),
  );

  it.effect("keeps an interval the user set and sends sitreps on it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        const saved = yield* team.updateSettings({
          projectId: PROJECT_ID,
          sitrepIntervalMinutes: 20,
        });
        assert.strictEqual(saved.settings.intervalPinnedAt, "2026-11-04T00:00:00.000Z");
        yield* TestClock.adjust("1 minute");
        yield* startLead(pm, "Long job", harness.delegate);

        for (let minute = 2; minute < 20; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
        }
        assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);
        yield* TestClock.adjust("1 minute");
        yield* sitreps.check;
        assert.strictEqual((yield* sitrepRequests(harness, pm)).length, 1);
        yield* postSitrep(harness, pm, "Long job is planning.");

        // A day later, neither progress checks, Sitrep now, nor unread sitreps move it.
        yield* TestClock.adjust("25 hours");
        yield* team.teamStatus(pm, {});
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        yield* postSitrep(harness, pm, "Still planning.");
        for (let i = 0; i < 3; i++) {
          yield* sitreps.noteMilestone(PROJECT_ID);
          yield* TestClock.adjust("20 minutes");
          yield* sitreps.check;
          yield* postSitrep(harness, pm, `Sitrep ${i}`);
        }
        const status = yield* team.teamStatus(pm, {});
        assert.strictEqual(status.settings.sitrepIntervalMinutes, 20);
      }),
    ),
  );

  it.effect("records the sitrep, not a follow-up the PM wrote after it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        yield* TestClock.adjust("1 second");
        yield* writeInSitrepTurn(harness, pm, "Checking the board.");
        yield* TestClock.adjust("1 second");
        yield* team.teamStatus(pm, {});
        yield* TestClock.adjust("1 second");
        yield* writeInSitrepTurn(harness, pm, "Cache is done; Search is in review.");
        yield* TestClock.adjust("1 second");
        yield* writeInSitrepTurn(harness, pm, "Approval relayed. Start on Search next?");
        yield* finishSitrepTurn(harness, pm);
        const latest = Option.getOrThrow(yield* repository.getLatestSitrep(PROJECT_ID));
        assert.strictEqual(latest.body, "Cache is done; Search is in review.");
      }),
    ),
  );

  it.effect("sends a requested sitrep at once and never two at a time", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        yield* sitreps.handle(userMessage(pm, "2026-11-04T00:00:00.000Z"));
        const first = yield* team.requestSitrep({ projectId: PROJECT_ID });
        const second = yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.strictEqual(second.sitrepId, first.sitrepId);
        const requests = yield* sitrepRequests(harness, pm);
        assert.strictEqual(requests.length, 1);
        assert.include(requests[0], "The user asked for this sitrep");
        const status = yield* team.teamStatus(pm, {});
        assert.strictEqual(status.settings.sitrepIntervalMinutes, 30);

        yield* postSitrep(harness, pm, "All quiet.");
        const third = yield* team.requestSitrep({ projectId: PROJECT_ID });
        assert.notStrictEqual(third.sitrepId, first.sitrepId);
      }),
    ),
  );

  it.effect("marks sitreps read when the user writes to the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        yield* postSitrep(harness, pm, "Status.");
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.unreadSitrepCount, 1);
        yield* sitreps.handle(userMessage(pm, "2026-11-04T00:10:00.000Z"));
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.unreadSitrepCount, 0);
      }),
    ),
  );

  it("knows quiet hours that wrap past midnight", () => {
    const night: ProjectTeamQuietHours = { start: "22:00", end: "07:00" };
    assert.isTrue(isWithinQuietHours(night, 23 * 60));
    assert.isTrue(isWithinQuietHours(night, 6 * 60 + 59));
    assert.isFalse(isWithinQuietHours(night, 7 * 60));
    assert.isFalse(isWithinQuietHours(undefined, 0));
    assert.isTrue(isWithinQuietHours({ start: "09:00", end: "17:00" }, 12 * 60));
  });
});
