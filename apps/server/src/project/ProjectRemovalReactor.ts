import {
  type ApplicationStoredEvent,
  CommandId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * Removing a project keeps its conversations. Once `project.deleted` commits, every
 * thread of the project is archived through the normal archive path, which ends
 * its sessions and removes worktrees that have no uncommitted changes. Adding the
 * folder again restores the project (`project.created` with
 * `restoredFromDeletedAt`), and the threads the removal archived come back.
 * Threads archived before the removal stay archived.
 */
export class ProjectRemovalReactor extends Context.Service<
  ProjectRemovalReactor,
  {
    /** Archives the threads of removed projects that are still active. */
    readonly sweep: Effect.Effect<void>;
    readonly handle: (event: ApplicationStoredEvent) => Effect.Effect<void>;
  }
>()("t3/project/ProjectRemovalReactor") {}

/** How deep a thread sits in its project's lineage; roots are 0. */
function lineageDepth(
  thread: OrchestrationV2ThreadShell,
  byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): number {
  let depth = 0;
  let parentId = thread.lineage.parentThreadId;
  const seen = new Set<ThreadId>([thread.id]);
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    seen.add(parentId);
    depth += 1;
    parentId = parent.lineage.parentThreadId;
  }
  return depth;
}

/** Children before parents: a worktree is kept while any active thread still uses it. */
const deepestFirst = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return threads.toSorted((left, right) => lineageDepth(right, byId) - lineageDepth(left, byId));
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const projectThreads = (projectId: ProjectId, location: "active" | "archive") =>
    threads
      .getShellSnapshot({ location })
      .pipe(
        Effect.map((snapshot) =>
          (location === "active" ? snapshot.threads : snapshot.archivedThreads).filter(
            (thread) => thread.projectId === projectId && thread.deletedAt === null,
          ),
        ),
      );

  const archiveThreads = (projectId: ProjectId, deletedAt: string) =>
    Effect.gen(function* () {
      for (const thread of deepestFirst(yield* projectThreads(projectId, "active"))) {
        yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`project-remove:${projectId}:${deletedAt}:${thread.id}`),
            threadId: thread.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not archive a removed project's thread", {
                projectId,
                threadId: thread.id,
                cause,
              }),
            ),
          );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not archive a removed project's threads", { projectId, cause }),
      ),
    );

  const restoreThreads = (projectId: ProjectId, removedAt: string, eventId: string) =>
    Effect.gen(function* () {
      const removedAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(removedAt));
      const archivedByRemoval = (yield* projectThreads(projectId, "archive")).filter(
        (thread) =>
          thread.archivedAt !== null &&
          DateTime.toEpochMillis(thread.archivedAt) >= removedAtMillis,
      );
      // Parents first, so a helper comes back into its parent's restored worktree.
      for (const thread of deepestFirst(archivedByRemoval).toReversed()) {
        yield* threads
          .dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(`project-restore:${eventId}:${thread.id}`),
            threadId: thread.id,
            ...(thread.worktreePath === null ? {} : { restoreWorktree: true }),
          })
          .pipe(
            // The PM reactor may have brought the PM back first.
            Effect.catchCause((cause) =>
              Effect.logInfo("could not unarchive a restored project's thread", {
                projectId,
                threadId: thread.id,
                cause,
              }),
            ),
          );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not restore a project's threads", { projectId, cause }),
      ),
    );

  const sweep: ProjectRemovalReactor["Service"]["sweep"] = projects
    .list({ includeDeleted: true })
    .pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => row.deletedAt !== null),
          (row) => archiveThreads(row.projectId, row.deletedAt!),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not sweep removed projects' threads", { cause }),
      ),
    );

  const handle: ProjectRemovalReactor["Service"]["handle"] = (event) => {
    if (!("aggregateKind" in event)) return Effect.void;
    if (event.type === "project.deleted") {
      return archiveThreads(event.payload.projectId, event.payload.deletedAt);
    }
    if (event.type === "project.created" && event.payload.restoredFromDeletedAt !== undefined) {
      return restoreThreads(
        event.payload.projectId,
        event.payload.restoredFromDeletedAt,
        event.eventId,
      );
    }
    return Effect.void;
  };

  return { sweep, handle } satisfies ProjectRemovalReactor["Service"];
});

export const layer = Layer.effect(ProjectRemovalReactor, make);

/** Sweeps once at startup, then follows project removals and restores. */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ProjectRemovalReactor;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const afterSequence = yield* events.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    yield* forkParked(
      reactor.sweep.pipe(
        Effect.andThen(
          Stream.runForEach(events.streamApplicationEvents({ afterSequence }), reactor.handle),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("project removal event stream failed", { cause }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(layer));
