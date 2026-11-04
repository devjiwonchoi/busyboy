import { assert, describe, it } from "@effect/vitest";
import type { ProjectTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { StalledTaskSweep, stalledNoticeText } from "./StalledTaskSweep.ts";
import { setUpManager, startLead, withTeam } from "./testkit.ts";

const markStalled = (task: ProjectTask) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    yield* team.recordOutcome({ task, outcome: "stalled" });
  });

describe("StalledTaskSweep", () => {
  it.effect("tells an idle PM once after a task has been stalled for 10 minutes", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sweep = yield* StalledTaskSweep;
        const pm = yield* setUpManager;
        const first = yield* startLead(pm, "First", harness.delegate);
        const second = yield* startLead(pm, "Second", harness.delegate);
        yield* markStalled(first.task);
        yield* markStalled(second.task);

        for (let minute = 1; minute <= 10; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* sweep.sweep;
        }
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);

        yield* TestClock.adjust("1 minute");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), [
          "2 tasks look stalled: #1, #2. Check team_status.",
        ]);

        for (let minute = 1; minute <= 15; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* sweep.sweep;
        }
        assert.strictEqual((yield* harness.messagesTo(pm)).length, 1);
      }),
    ),
  );

  it.effect("waits while the PM is running or recently nudged the task", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sweep = yield* StalledTaskSweep;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Slow", harness.delegate);
        yield* markStalled(lead.task);

        yield* TestClock.adjust("11 minutes");
        harness.threads.get(pm)!.activeRunId = "run-pm";
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);

        harness.threads.get(pm)!.activeRunId = null;
        yield* team.nudgeTask(pm, { taskId: lead.task.id });
        yield* TestClock.adjust("5 minutes");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);

        yield* TestClock.adjust("6 minutes");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), [stalledNoticeText([lead.task])]);
      }),
    ),
  );

  it.effect("skips a task whose lead is running or has delegated children at work", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sweep = yield* StalledTaskSweep;
        const pm = yield* setUpManager;
        const running = yield* startLead(pm, "Running", harness.delegate);
        const fanOut = yield* startLead(pm, "Fan out", harness.delegate);
        yield* markStalled(running.task);
        yield* markStalled(fanOut.task);
        const runningLead = harness.addThread(running.leadThreadId);
        runningLead.activeRunId = "run-lead";
        const fanOutLead = harness.addThread(fanOut.leadThreadId);
        fanOutLead.subagents = [{ origin: "app_owned", status: "waiting" }];

        yield* TestClock.adjust("11 minutes");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);

        runningLead.activeRunId = null;
        yield* TestClock.adjust("1 minute");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), [stalledNoticeText([running.task])]);
      }),
    ),
  );

  it.effect("stays quiet while the PM is turned off and resumes when it is back on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const sweep = yield* StalledTaskSweep;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Slow", harness.delegate);
        yield* markStalled(lead.task);
        yield* team.updateSettings({ projectId: lead.task.projectId, enabled: false });

        yield* TestClock.adjust("11 minutes");
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), []);
        assert.isDefined(harness.threads.get(pm));

        yield* team.updateSettings({ projectId: lead.task.projectId, enabled: true });
        yield* sweep.sweep;
        assert.deepStrictEqual(yield* harness.messagesTo(pm), [stalledNoticeText([lead.task])]);
      }),
    ),
  );
});
