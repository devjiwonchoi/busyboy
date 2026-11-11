import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";

const GIT_TIMEOUT = Duration.seconds(20);
/** Read by parseRevertCommits: sha, subject and body, one record per commit. */
export const REVERT_LOG_FORMAT = "--format=%H%x1f%cI%x1f%s%x1f%b%x1e";
const SINCE = "--since=90 days ago";

export class RevertLogReader extends Context.Service<
  RevertLogReader,
  {
    /**
     * The last 90 days of the default branch's history as fetched (origin/HEAD, else
     * origin/main) in REVERT_LOG_FORMAT; None when it can't be read. Never fails.
     */
    readonly read: (workspaceRoot: string) => Effect.Effect<Option.Option<string>>;
  }
>()("t3/projectTeam/RevertLogReader") {}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const logOf = (workspaceRoot: string, ref: string) =>
    processRunner
      .run({
        command: "git",
        args: ["log", ref, SINCE, REVERT_LOG_FORMAT],
        cwd: workspaceRoot,
        timeout: GIT_TIMEOUT,
        maxOutputBytes: 20_000_000,
      })
      .pipe(
        Effect.map((result) =>
          result.code === 0 && !result.timedOut
            ? Option.some(result.stdout)
            : Option.none<string>(),
        ),
      );

  const read = (workspaceRoot: string): Effect.Effect<Option.Option<string>> =>
    logOf(workspaceRoot, "origin/HEAD").pipe(
      Effect.flatMap((log) =>
        Option.isSome(log) ? Effect.succeed(log) : logOf(workspaceRoot, "origin/main"),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read the git log for reverts", { workspaceRoot, cause }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );

  return RevertLogReader.of({ read });
});

export const layer: Layer.Layer<RevertLogReader, never, ProcessRunner.ProcessRunner> = Layer.effect(
  RevertLogReader,
  make,
);

export const layerTest = (
  read: (workspaceRoot: string) => Option.Option<string>,
): Layer.Layer<RevertLogReader> =>
  Layer.succeed(
    RevertLogReader,
    RevertLogReader.of({ read: (workspaceRoot) => Effect.sync(() => read(workspaceRoot)) }),
  );
