import { assert, describe, it } from "@effect/vitest";
import type { ProjectAttentionItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { RETIRED_PLAN_APPROVAL_ANSWER, retirePlanApprovals } from "./PlanApprovalCleanup.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, startLead, withTeam } from "./testkit.ts";

/** Marks a card the way the removed plan approval feature saved it. */
const markAsPlanApproval = (id: ProjectAttentionItemId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE project_attention_items SET kind = 'approval' WHERE item_id = ${id}`;
  });

const countPlanApprovals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM project_attention_items WHERE kind = 'approval'
  `;
  return rows[0]?.count ?? 0;
});

describe("PlanApprovalCleanup", () => {
  it.effect("closes a plan card left open by an older version and lets its lead go on", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const waiting = yield* startLead(pm, "Fix login", harness.delegate);
        const decided = yield* startLead(pm, "Fix logout", harness.delegate);

        // Before the upgrade: one lead waits on its plan card, another plan was already approved.
        const open = yield* team.askUser(waiting.leadThreadId, {
          kind: "decision",
          question: "Fix login: approve the plan?",
          options: ["Approve and start", "Approve only"],
        });
        yield* markAsPlanApproval(open.item.id);
        const answered = yield* team.askUser(decided.leadThreadId, {
          kind: "decision",
          question: "Fix logout: approve the plan?",
          options: ["Approve and start", "Approve only"],
        });
        yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: answered.item.id,
          answer: "Approve and start",
        });
        yield* markAsPlanApproval(answered.item.id);
        yield* Ref.set(harness.sent, []);

        // Old rows still read, as decisions, until the cleanup runs.
        const before = yield* team.teamStatus(pm, {});
        assert.deepStrictEqual(
          before.openAttention.map((item) => [item.id, item.kind]),
          [[open.item.id, "decision"]],
        );

        yield* retirePlanApprovals;

        // The waiting lead hears "Approve and start", the answer it was told to wait for.
        const relays = yield* Ref.get(harness.sent);
        assert.deepStrictEqual(
          relays.map((relay) => [relay.threadId, relay.senderThreadId]),
          [[waiting.leadThreadId, pm]],
        );
        assert.strictEqual(
          relays[0]?.text,
          `[User answer via BusyBoy] Fix login: approve the plan? → ${RETIRED_PLAN_APPROVAL_ANSWER}`,
        );
        assert.isTrue(relays[0]?.text.includes("→ Approve and start\nNote:"));

        // No card is left for the user, and no plan approval rows remain.
        const after = (yield* team.attentionSnapshot).projects[0];
        assert.strictEqual(after?.openCount, 0);
        assert.strictEqual(yield* countPlanApprovals, 0);

        // A later start finds nothing to do.
        yield* retirePlanApprovals;
        assert.strictEqual((yield* Ref.get(harness.sent)).length, 1);
      }),
    ),
  );

  it.effect("keeps a card open for the next start when its answer cannot be delivered", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fix login", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "decision",
          question: "Approve the plan?",
        });
        yield* markAsPlanApproval(item.id);

        harness.sendFailures.remaining = 1;
        yield* retirePlanApprovals;
        assert.strictEqual(yield* countPlanApprovals, 1);

        yield* retirePlanApprovals;
        assert.strictEqual(yield* countPlanApprovals, 0);
        assert.strictEqual((yield* team.attentionSnapshot).projects[0]?.openCount, 0);
      }),
    ),
  );
});
