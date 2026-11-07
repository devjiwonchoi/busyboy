import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";

const GIT_TIMEOUT = Duration.seconds(10);

export class WorktreeHeadReader extends Context.Service<
  WorktreeHeadReader,
  {
    /** The commit checked out in a worktree; None when it can't be read. Never fails. */
    readonly read: (worktreePath: string) => Effect.Effect<Option.Option<string>>;
  }
>()("t3/projectTeam/WorktreeHeadReader") {}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const read = (worktreePath: string): Effect.Effect<Option.Option<string>> =>
    processRunner
      .run({
        command: "git",
        args: ["rev-parse", "HEAD"],
        cwd: worktreePath,
        timeout: GIT_TIMEOUT,
        maxOutputBytes: 1_000,
      })
      .pipe(
        Effect.map((result) => {
          const head = result.stdout.trim();
          return result.code === 0 && !result.timedOut && head.length > 0
            ? Option.some(head)
            : Option.none<string>();
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read a worktree's HEAD", { worktreePath, cause }).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );

  return WorktreeHeadReader.of({ read });
});

export const layer: Layer.Layer<WorktreeHeadReader, never, ProcessRunner.ProcessRunner> =
  Layer.effect(WorktreeHeadReader, make);

export const layerTest = (
  read: (worktreePath: string) => Option.Option<string>,
): Layer.Layer<WorktreeHeadReader> =>
  Layer.succeed(
    WorktreeHeadReader,
    WorktreeHeadReader.of({ read: (worktreePath) => Effect.sync(() => read(worktreePath)) }),
  );
