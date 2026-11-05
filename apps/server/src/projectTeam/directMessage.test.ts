import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, startLead, withTeam } from "./testkit.ts";

describe("direct messages from task cards", () => {
  it.effect(
    "sends the user's message straight to the lead and journals it without waking the PM",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          const lead = yield* startLead(pm, "Fix login", harness.delegate);
          const other = yield* startLead(pm, "Sidebar cleanup", harness.delegate);
          yield* team.updateTask(lead.leadThreadId, {
            note: "Found the bug in the session check.",
          });

          // The PM thread shows one card per active task, with the latest update.
          const before = (yield* team.attentionSnapshot).projects[0];
          assert.deepStrictEqual(
            before?.taskCards.map((card) => card.title),
            ["Fix login", "Sidebar cleanup"],
          );
          assert.strictEqual(
            before?.taskCards[0]?.latestUpdate?.text,
            "Found the bug in the session check.",
          );
          assert.isNull(before?.taskCards[0]?.lastDirectMessage);

          const toPmBefore = (yield* harness.messagesTo(pm)).length;
          yield* TestClock.adjust("1 minute");
          const sent = yield* team.messageTask({
            projectId: PROJECT_ID,
            taskId: lead.task.id,
            text: "Also cover the logout path.",
          });
          assert.strictEqual(sent.event.kind, "direct_message");

          // Straight to the lead, as the user. "auto" steers into a running turn.
          const relays = (yield* Ref.get(harness.sent)).filter(
            (input) => input.threadId === lead.leadThreadId,
          );
          const relay = relays.at(-1);
          assert.strictEqual(
            relay?.text,
            "[Direct message from the user via BusyBoy] Also cover the logout path.",
          );
          assert.strictEqual(relay?.mode, "auto");
          assert.strictEqual(relay?.createdBy, "user");
          assert.isUndefined(relay?.senderThreadId);
          assert.isFalse(
            (yield* Ref.get(harness.sent)).some((input) => input.threadId === other.leadThreadId),
          );

          // The PM is not woken: it stays free for the user.
          assert.strictEqual((yield* harness.messagesTo(pm)).length, toPmBefore);

          // The card shows what the user sent; team_status journals it for the PM.
          const after = (yield* team.attentionSnapshot).projects[0];
          assert.strictEqual(
            after?.taskCards[0]?.lastDirectMessage?.text,
            "Also cover the logout path.",
          );
          const status = yield* team.teamStatus(pm, {});
          const entry = status.journal.find((item) => item.kind === "message");
          assert.strictEqual(
            entry?.text,
            `The user messaged #${lead.task.number}'s lead: Also cover the logout path.`,
          );
        }),
      ),
  );

  it.effect("refuses a task with no active lead", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, { title: "Later", request: "Later." });
        const result = yield* Effect.result(
          team.messageTask({ projectId: PROJECT_ID, taskId: task.id, text: "Hi" }),
        );
        assert.strictEqual(result._tag, "Failure");
      }),
    ),
  );
});
