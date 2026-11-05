import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { SitrepScheduler } from "./SitrepScheduler.ts";
import { setUpManager, START, startLead, type TeamHarness, withTeam } from "./testkit.ts";

const sitrepRequests = (harness: TeamHarness, pm: ThreadId) =>
  harness
    .messagesTo(pm)
    .pipe(Effect.map((texts) => texts.filter((text) => text.startsWith("[Sitrep due]"))));

const QUESTION = "Use the REA MCP server or the CLI for the binary scan?";

describe("PM status covers threads outside the task board", () => {
  it.effect(
    "a thread the user started shows in team_status and sitreps, and its question counts as Needs you",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const sitreps = yield* SitrepScheduler;
          const pm = yield* setUpManager;
          // A task lead's thread belongs to the board, not to "other threads".
          const { leadThreadId } = yield* startLead(pm, "Tidy the sidebar", harness.delegate);
          harness.addThread(leadThreadId);
          const leadSitreps = (yield* sitrepRequests(harness, pm)).length;

          // An hour later, the user starts a thread of their own and it starts working.
          yield* TestClock.adjust("61 minutes");
          const startedAt = yield* DateTime.now;
          const userThread = harness.addThread(ThreadId.make("thread-rea"));
          userThread.title = "REA 조사와 활용 개선 방법";
          userThread.activeRunId = "run-1";
          userThread.shell = {
            status: "running",
            createdAt: startedAt,
            updatedAt: startedAt,
            latestRunStartedAt: startedAt,
            latestVisibleMessage: {
              role: "assistant",
              text: "Reading the REA tool list.",
              updatedAt: startedAt,
            } as OrchestrationV2ThreadShell["latestVisibleMessage"],
          };

          // The new thread is a change, so the next sitrep goes out.
          yield* sitreps.check;
          assert.strictEqual((yield* sitrepRequests(harness, pm)).length, leadSitreps + 1);

          const running = yield* team.teamStatus(pm, {});
          assert.deepStrictEqual(
            running.otherThreads.map((thread) => thread.threadId),
            [userThread.id],
          );
          assert.strictEqual(running.otherThreads[0]?.title, "REA 조사와 활용 개선 방법");
          assert.strictEqual(running.otherThreads[0]?.status, "running");
          assert.strictEqual(running.otherThreads[0]?.latestMessage, "Reading the REA tool list.");
          assert.strictEqual(running.otherThreads[0]?.pendingRequest, null);

          // The thread asks the user a question.
          yield* TestClock.adjust("5 minutes");
          const askedAt = yield* DateTime.now;
          userThread.shell = {
            ...userThread.shell,
            status: "waiting",
            pendingRuntimeRequest: {
              id: "request-1",
              kind: "user_input",
              createdAt: askedAt,
            } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          };
          userThread.turnItems = [
            {
              type: "user_input_request",
              requestId: "request-1",
              questions: [{ id: "q1", header: "Tooling", question: QUESTION, options: [] }],
            } as unknown as OrchestrationV2TurnItem,
          ];
          assert.strictEqual(yield* openCountAfterRequestEvent(userThread.id), 1);

          const waiting = yield* team.teamStatus(pm, {});
          const entry = waiting.otherThreads[0];
          assert.strictEqual(entry?.status, "waiting_on_user");
          assert.deepStrictEqual(entry?.pendingRequest, {
            kind: "question",
            text: QUESTION,
            since: DateTime.formatIso(askedAt),
          });
          assert.deepStrictEqual(
            waiting.changes.otherThreads.map((thread) => thread.threadId),
            [userThread.id],
          );

          const needsYou = (yield* team.attentionSnapshot).projects[0];
          assert.strictEqual(needsYou?.openCount, 1);
          assert.strictEqual(needsYou?.presence.waitingOnUser, 1);

          // The user answers and the thread finishes: nothing waits on the user any more.
          userThread.activeRunId = null;
          userThread.shell = {
            ...userThread.shell,
            status: "completed",
            pendingRuntimeRequest: null,
            latestRunCompletedAt: yield* DateTime.now,
          };
          userThread.turnItems = [];
          const done = yield* team.teamStatus(pm, {});
          assert.strictEqual(done.otherThreads[0]?.status, "idle");
          const answered = (yield* team.attentionSnapshot).projects[0];
          assert.strictEqual(answered?.openCount, 0);
          assert.strictEqual(answered?.presence.waitingOnUser, 0);
        }),
      ),
  );

  it.effect("skips archived threads and lists the ones waiting on the user first", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const now = yield* DateTime.now;
        const idle = harness.addThread(ThreadId.make("thread-idle"));
        idle.shell = { latestRunCompletedAt: DateTime.add(now, { minutes: 5 }) };
        const failed = harness.addThread(ThreadId.make("thread-failed"));
        failed.shell = { status: "failed" };
        const approval = harness.addThread(ThreadId.make("thread-approval"));
        approval.activeRunId = "run-2";
        approval.shell = {
          status: "waiting",
          pendingRuntimeRequest: {
            id: "request-2",
            kind: "command",
            createdAt: now,
          } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
        };
        approval.turnItems = [
          {
            type: "approval_request",
            requestId: "request-2",
            requestKind: "command",
            prompt: "Run pnpm install?",
          } as unknown as OrchestrationV2TurnItem,
        ];
        const archived = harness.addThread(ThreadId.make("thread-archived"));
        archived.archivedAt = START;

        const status = yield* team.teamStatus(pm, {});
        assert.deepStrictEqual(
          status.otherThreads.map((thread) => [thread.threadId, thread.status]),
          [
            ["thread-approval", "waiting_on_user"],
            ["thread-failed", "failed"],
            ["thread-idle", "idle"],
          ],
        );
        assert.strictEqual(status.otherThreads[0]?.pendingRequest?.kind, "approval");
        assert.strictEqual(status.otherThreads[0]?.pendingRequest?.text, "Run pnpm install?");
      }),
    ),
  );
});

/**
 * Feeds a runtime-request event for the thread to the sitrep scheduler and returns the
 * "Needs you" count of the attention snapshot it pushes, so the badge updates.
 */
const openCountAfterRequestEvent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    const sitreps = yield* SitrepScheduler;
    const snapshots = yield* Stream.take(team.streamAttention, 2).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    // Let the stream emit its first snapshot and subscribe before the event.
    yield* TestClock.adjust("1 millis");
    yield* sitreps.handle({
      id: EventId.make("event-request-1"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: {},
    } as unknown as OrchestrationV2DomainEvent);
    const all = yield* Fiber.join(snapshots);
    return [...all].at(-1)?.projects[0]?.openCount;
  });
