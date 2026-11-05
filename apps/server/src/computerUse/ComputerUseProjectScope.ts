/**
 * Which project a computer-use call belongs to, for "Always allow in this
 * project". Scratch (no project) chats get no project: they share one
 * folder, so an "always" there would cover every unrelated chat.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";

export interface ComputerUseProject {
  readonly projectId: string;
  readonly projectName: string;
}

export class ComputerUseProjectScope extends Context.Service<
  ComputerUseProjectScope,
  {
    /** `None` for scratch chats and when the project can't be read. */
    readonly projectOf: (threadId: ThreadId) => Effect.Effect<Option.Option<ComputerUseProject>>;
  }
>()("t3/computerUse/ComputerUseProjectScope") {}

export const layer = Layer.effect(
  ComputerUseProjectScope,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const path = yield* Path.Path;
    const projectOf = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null) return Option.none<ComputerUseProject>();
        const project = yield* projects.getById(shell.projectId);
        if (Option.isNone(project)) return Option.none<ComputerUseProject>();
        const scratch = yield* folders.scratchRoot;
        if (
          Option.isSome(scratch) &&
          path.resolve(scratch.value) === path.resolve(project.value.workspaceRoot)
        ) {
          return Option.none<ComputerUseProject>();
        }
        return Option.some<ComputerUseProject>({
          projectId: project.value.id,
          projectName: project.value.title,
        });
      }).pipe(Effect.orElseSucceed(() => Option.none<ComputerUseProject>()));
    return { projectOf };
  }),
);

/** For tests: a fixed thread → project map. */
export const layerTest = (projects: ReadonlyMap<string, ComputerUseProject>) =>
  Layer.succeed(ComputerUseProjectScope, {
    projectOf: (threadId: ThreadId) => Effect.succeed(Option.fromNullishOr(projects.get(threadId))),
  });
