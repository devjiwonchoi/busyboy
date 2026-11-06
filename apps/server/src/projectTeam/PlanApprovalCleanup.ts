import type { ProjectAttentionItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { forkParked } from "../serverActivation.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import { nowIso } from "./common.ts";

/**
 * The answer a plan approval card still open at upgrade gets. Its lead was told to wait for
 * "Approve and start", so the answer starts with that and says why.
 */
export const RETIRED_PLAN_APPROVAL_ANSWER = [
  "Approve and start",
  'Note: Plan approval cards were removed, and the user asked for every waiting plan to go ahead. Call task_update(stage: "running", planSummary) and implement it.',
].join("\n");

/**
 * Plan approval cards were removed. Answers the ones still open so their leads carry on,
 * then turns every old approval card into a plain decision. A card whose answer cannot be
 * delivered stays open and is retried at the next start.
 */
export const retirePlanApprovals = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const router = yield* AttentionRouter.AttentionRouter;

  const close = (item: ProjectAttentionItem) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(item.projectId);
      const senderThreadId = Option.isSome(manager) ? manager.value.threadId : item.askerThreadId;
      if (senderThreadId === null) {
        // Nobody to tell: just record the answer.
        yield* repository.answerAttentionItem({
          id: item.id,
          answer: RETIRED_PLAN_APPROVAL_ANSWER,
          answeredAt: yield* nowIso,
          answeredBy: "user",
        });
        return;
      }
      yield* router.answer({
        item,
        answer: RETIRED_PLAN_APPROVAL_ANSWER,
        senderThreadId,
        answeredBy: "user",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team could not close an old plan approval card", {
          attentionItemId: item.id,
          cause,
        }),
      ),
    );

  const open = yield* repository.listOpenPlanApprovals();
  yield* Effect.forEach(open, close, { discard: true });
  yield* repository.retireClosedPlanApprovals();
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("project team plan approval cleanup failed", { cause }),
  ),
);

/** Runs the cleanup once at startup. */
export const layerWorker = Layer.effectDiscard(forkParked(retirePlanApprovals));
