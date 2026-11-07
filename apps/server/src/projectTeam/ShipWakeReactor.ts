import type { OrchestrationV2DomainEvent, PullRequestWatchChangeKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";

/** Pull request news that sends shipped work back for another round. Passed checks do not. */
const REOPENING: ReadonlySet<PullRequestWatchChangeKind> = new Set([
  "checks-failed",
  "remarks",
  "conflicting",
]);

/** Message ids already handled; a message is reported again on every update. */
const SEEN_LIMIT = 500;

export class ShipWakeReactor extends Context.Service<
  ShipWakeReactor,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/ShipWakeReactor") {}

const make = Effect.gen(function* () {
  const team = yield* ProjectTeamService.ProjectTeamService;
  const seen = yield* Ref.make<ReadonlyArray<string>>([]);

  const handle: ShipWakeReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "message.updated") return;
      const notification = event.payload.notification;
      if (notification === undefined || notification.source.kind !== "monitor") return;
      const changes = notification.source.pullRequestChanges ?? [];
      if (!changes.some((change) => REOPENING.has(change))) return;
      const id = event.payload.id as string;
      const fresh = yield* Ref.modify(seen, (ids) =>
        ids.includes(id) ? [false, ids] : [true, [...ids, id].slice(-SEEN_LIMIT)],
      );
      if (!fresh) return;
      yield* team.recordShipWake({
        leadThreadId: event.payload.threadId,
        summary: notification.summary,
        checksFailed: changes.includes("checks-failed"),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team ship wake failed", { threadId: event.threadId, cause }),
      ),
    );

  return { handle } satisfies ShipWakeReactor["Service"];
});

export const layer = Layer.effect(ShipWakeReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ShipWakeReactor;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, reactor.handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project team ship wake stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
