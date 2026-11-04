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

/** Ends the PM's turn for the latest sitrep request with the given text. */
const postSitrep = (harness: TeamHarness, pm: ThreadId, text: string) =>
  Effect.gen(function* () {
    const sitreps = yield* SitrepScheduler;
    const request = (yield* Ref.get(harness.dispatched))
      .filter((command) => command.type === "message.dispatch" && command.threadId === pm)
      .at(-1);
    assert(request?.type === "message.dispatch");
    const runId = `run-${request.messageId}`;
    harness.threads.get(pm)!.messages.push(assistantMessage({ threadId: pm, runId, text }));
    yield* sitreps.handle({
      id: EventId.make(`event-${runId}`),
      threadId: pm,
      occurredAt: DateTime.makeUnsafe(START),
      type: "run.updated",
      payload: { id: runId, threadId: pm, status: "completed", userMessageId: request.messageId },
    } as unknown as OrchestrationV2DomainEvent);
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
  it.effect(
    "sends one sitrep three minutes after the first milestone and folds in later ones",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const sitreps = yield* SitrepScheduler;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          const a = yield* startLead(pm, "Hello", harness.delegate);
          const b = yield* startLead(pm, "Goodbye", harness.delegate);

          yield* team.updateTask(a.leadThreadId, {
            stage: "done",
            resultSummary: "Added hello.sh.",
          });
          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
          yield* team.updateTask(b.leadThreadId, {
            stage: "done",
            resultSummary: "Added goodbye.sh.",
          });
          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
          assert.deepStrictEqual(yield* sitrepRequests(harness, pm), []);

          yield* TestClock.adjust("1 minute");
          yield* sitreps.check;
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

  it.effect("skips interval sitreps without changes but sends a liveness note", () =>
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

        yield* TestClock.adjust("60 minutes");
        yield* sitreps.check;
        const requests = yield* sitrepRequests(harness, pm);
        assert.strictEqual(requests.length, 2);
        assert.include(
          requests[1],
          "Nothing changed; one line on what is still running is enough.",
        );
      }),
    ),
  );

  it.effect("waits while the user is talking to the PM or the PM is running", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        yield* sitreps.noteMilestone(PROJECT_ID);
        yield* TestClock.adjust("150 seconds");
        yield* sitreps.handle(userMessage(pm, "2026-11-04T00:02:30.000Z"));
        yield* TestClock.adjust("30 seconds");
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

  it.effect("halves the interval once per sitrep window when the user asks, down to 15", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const sitreps = yield* SitrepScheduler;
        const pm = yield* setUpManager;
        const interval = team
          .teamStatus(pm, {})
          .pipe(Effect.map((status) => status.settings.sitrepIntervalMinutes));
        yield* TestClock.adjust("1 minute");
        yield* team.teamStatus(pm, { reason: "user_asked" });
        yield* team.teamStatus(pm, { reason: "user_asked" });
        assert.strictEqual(yield* interval, 30);

        yield* sitreps.noteMilestone(PROJECT_ID);
        yield* TestClock.adjust("3 minutes");
        yield* sitreps.check;
        const [request] = yield* sitrepRequests(harness, pm);
        assert.include(
          request,
          "Mention: interval changed to 30 min because you asked for progress before the next sitrep",
        );
        yield* postSitrep(harness, pm, "All quiet.");

        yield* TestClock.adjust("16 minutes");
        yield* team.teamStatus(pm, { reason: "user_asked" });
        assert.strictEqual(yield* interval, 15);
        yield* TestClock.adjust("8 minutes");
        yield* team.teamStatus(pm, { reason: "user_asked" });
        assert.strictEqual(yield* interval, 15);
      }),
    ),
  );

  it.effect("halves only once when the Sitrep button and the PM both report the ask", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        yield* TestClock.adjust("1 minute");
        yield* team.requestSitrep({ projectId: PROJECT_ID });
        const status = yield* team.teamStatus(pm, { reason: "user_asked" });
        assert.strictEqual(status.settings.sitrepIntervalMinutes, 30);
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
          yield* TestClock.adjust("3 minutes");
          yield* sitreps.check;
          yield* postSitrep(harness, pm, `Sitrep ${i}`);
        }
        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.strictEqual(manager.settings.sitrepIntervalMinutes, 120);
        assert.strictEqual(manager.unreadSitrepStreak, 0);
      }),
    ),
  );

  it.effect("leaves a pinned interval alone", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        yield* team.updateSettingsAsManager(pm, { sitrepIntervalMinutes: 90 });
        yield* TestClock.adjust("23 hours");
        const pinned = yield* team.teamStatus(pm, { reason: "user_asked" });
        assert.strictEqual(pinned.settings.sitrepIntervalMinutes, 90);
        yield* TestClock.adjust("2 hours");
        yield* team.teamStatus(pm, { reason: "user_asked" });
        const unpinned = yield* team.teamStatus(pm, {});
        assert.strictEqual(unpinned.settings.sitrepIntervalMinutes, 45);
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
