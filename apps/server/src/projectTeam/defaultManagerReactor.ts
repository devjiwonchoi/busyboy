import type { ApplicationStoredEvent, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";

export class DefaultManagerReactor extends Context.Service<
  DefaultManagerReactor,
  {
    /** Gives every project that is not deleted a PM. */
    readonly ensureAll: Effect.Effect<void>;
    readonly handle: (event: ApplicationStoredEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/defaultManagerReactor") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const team = yield* ProjectTeamService.ProjectTeamService;

  const ensure = (projectId: ProjectId) =>
    team.ensureManager(projectId).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("project team PM setup failed", { projectId, cause }),
      ),
    );

  const ensureAll: DefaultManagerReactor["Service"]["ensureAll"] = projects.list().pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => ensure(row.projectId), { discard: true }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("project team PM setup failed", { cause })),
  );

  const handle: DefaultManagerReactor["Service"]["handle"] = (event) =>
    "aggregateKind" in event && event.type === "project.created"
      ? ensure(event.payload.projectId)
      : Effect.void;

  return { ensureAll, handle } satisfies DefaultManagerReactor["Service"];
});

export const layer = Layer.effect(DefaultManagerReactor, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* DefaultManagerReactor;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const afterSequence = yield* events.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    yield* forkParked(
      reactor.ensureAll.pipe(
        Effect.andThen(
          Stream.runForEach(events.streamApplicationEvents({ afterSequence }), reactor.handle),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("project team project event stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
