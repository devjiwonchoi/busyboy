import { type ApplicationStoredEvent, CommandId, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { forkParked } from "../serverActivation.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";

export class DefaultManagerReactor extends Context.Service<
  DefaultManagerReactor,
  {
    /**
     * Gives every project that is not deleted a PM, except "No project" (the
     * Scratch project), whose PM from before this rule is removed.
     */
    readonly ensureAll: Effect.Effect<void>;
    /**
     * Gives a new or restored project other than Scratch a PM (a restored one gets
     * its old PM back), and replaces a PM whose thread was deleted.
     */
    readonly handle: (event: ApplicationStoredEvent) => Effect.Effect<void>;
  }
>()("t3/projectTeam/defaultManagerReactor") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const team = yield* ProjectTeamService.ProjectTeamService;
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const router = yield* AttentionRouter.AttentionRouter;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const path = yield* Path.Path;

  const isScratch = (workspaceRoot: string) =>
    folders.scratchRoot.pipe(
      Effect.map(Option.exists((root) => path.resolve(root) === path.resolve(workspaceRoot))),
    );

  /** Removes a PM that was given to Scratch before Scratch was excluded. */
  const removeScratchManager = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const manager = yield* repository.getManager(projectId);
      if (Option.isNone(manager)) return;
      // Forget the PM first, so its thread's deletion does not provision a replacement.
      yield* repository.deleteManager(projectId);
      const threadId = manager.value.threadId;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell !== null && shell.deletedAt === null) {
        yield* threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`project-team:remove-scratch-pm:${threadId}`),
          threadId,
        });
      }
      yield* router.publish(projectId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project team Scratch PM removal failed", { projectId, cause }),
      ),
    );

  const ensure = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.flatMap((project) =>
        Option.isNone(project)
          ? Effect.void
          : isScratch(project.value.workspaceRoot).pipe(
              Effect.flatMap((scratch) =>
                scratch ? removeScratchManager(projectId) : team.ensureManager(projectId),
              ),
            ),
      ),
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

  const handle: DefaultManagerReactor["Service"]["handle"] = (event) => {
    if ("aggregateKind" in event) {
      return event.type === "project.created" ? ensure(event.payload.projectId) : Effect.void;
    }
    const { threadId, type } = event.event;
    // A removed project is skipped by ensure, so deleting its archived PM adds none.
    if (type !== "thread.deleted") return Effect.void;
    return repository.getManagerByThreadId(threadId).pipe(
      Effect.flatMap((manager) =>
        Option.isSome(manager) ? ensure(manager.value.projectId) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("project team PM replacement failed", { threadId, cause }),
      ),
    );
  };

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
