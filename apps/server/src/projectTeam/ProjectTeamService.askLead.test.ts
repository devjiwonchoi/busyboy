import { assert, describe, it } from "@effect/vitest";
import { ProjectAttentionItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  DIRECTOR_PROJECT_ID,
  PROJECT_ID,
  setUpManager,
  setUpWorkspace,
  startLead,
  withTeam,
} from "./testkit.ts";

describe("ProjectTeamService.askLead", () => {
  it.effect("sends a side chat question to the card's lead and leaves the card open", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const pm = yield* setUpManager;
        const lead = yield* startLead(pm, "Fix login", harness.delegate);
        const { item } = yield* team.askUser(lead.leadThreadId, {
          kind: "decision",
          question: "Ship the fix today?",
          options: ["Approve", "Request changes"],
        });
        const before = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: lead.task.id });

        const sentBefore = (yield* Ref.get(harness.sent)).length;
        yield* team.askLead({
          projectId: PROJECT_ID,
          attentionItemId: item.id,
          question: "왜 오늘이에요?",
          quotes: [{ section: "Summary", quote: "Ship today" }],
        });

        const sent = (yield* Ref.get(harness.sent)).slice(sentBefore);
        assert.strictEqual(sent.length, 1);
        const [relay] = sent;
        assert.strictEqual(relay?.threadId, lead.leadThreadId);
        assert.strictEqual(relay?.senderThreadId, pm);
        assert.match(relay?.text ?? "", /^\[사용자 질문\] 결정 · \S+ Fix login\n/);
        assert.include(relay?.text, `<!-- card:${item.id} -->`);
        assert.include(relay?.text, "> [Summary] Ship today");
        assert.isTrue(relay?.text.endsWith("\n\n왜 오늘이에요?"));

        // Asking is not answering: the card stays open and the task keeps its stage and plan.
        const card = (yield* team.attentionSnapshot).projects[0]?.decisionCards.find(
          (entry) => entry.item.id === item.id,
        );
        assert.strictEqual(card?.item.answeredAt, null);
        assert.strictEqual(card?.item.supersededAt, null);
        const after = yield* team.getTaskDetail({ projectId: PROJECT_ID, taskId: lead.task.id });
        assert.strictEqual(after.task.stage, before.task.stage);
        assert.strictEqual(after.versions.length, before.versions.length);
      }),
    ),
  );

  it.effect("sends a Director card's question to the task's lead, not the Director", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        const { firstPm, director } = yield* setUpWorkspace(harness);
        const lead = yield* startLead(firstPm, "Payments API", harness.delegate);
        const { item } = yield* team.askUser(director.threadId, {
          kind: "decision",
          taskId: lead.task.id,
          question: "결제 API는 어느 목표인가요?",
        });
        assert.strictEqual(item.askerThreadId, director.threadId);

        const sentBefore = (yield* Ref.get(harness.sent)).length;
        yield* team.askLead({
          projectId: DIRECTOR_PROJECT_ID,
          attentionItemId: item.id,
          question: "지금 어디까지 했어요?",
          quotes: [],
        });
        const sent = (yield* Ref.get(harness.sent)).slice(sentBefore);
        assert.deepStrictEqual(
          sent.map((relay) => relay.threadId),
          [lead.leadThreadId],
        );
        assert.match(sent[0]?.text ?? "", /^\[사용자 질문\] 결정 · \S+ Payments API\n/);
      }),
    ),
  );

  it.effect("refuses a card that is not in the project", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* ProjectTeamService.ProjectTeamService;
        yield* setUpManager;
        const error = yield* team
          .askLead({
            projectId: PROJECT_ID,
            attentionItemId: ProjectAttentionItemId.make("attention:missing"),
            question: "Hi?",
            quotes: [],
          })
          .pipe(Effect.flip);
        assert.include(error.message, "was not found in this project");
      }),
    ),
  );
});
