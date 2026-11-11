import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import type { PullRequestText } from "./pullRequestFormat.ts";

const GH_TIMEOUT = Duration.seconds(15);

const GhPullRequestJson = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  headRefName: Schema.optionalKey(Schema.String),
});
const decodeGhPullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(GhPullRequestJson));

export class PullRequestTextReader extends Context.Service<
  PullRequestTextReader,
  {
    /** The PR's title, body and head branch; None when it can't be read (no gh, offline, not a GitHub PR). Never fails. */
    readonly read: (url: string) => Effect.Effect<Option.Option<PullRequestText>>;
  }
>()("t3/projectTeam/PullRequestTextReader") {}

const isGitHubPullRequest = (url: string): boolean => {
  const link = parseChangeRequestUrl(url);
  return link !== null && link.host.includes("github");
};

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const read = (url: string): Effect.Effect<Option.Option<PullRequestText>> =>
    Effect.gen(function* () {
      if (!isGitHubPullRequest(url)) return Option.none();
      const result = yield* processRunner.run({
        command: "gh",
        args: ["pr", "view", url, "--json", "title,body,headRefName"],
        timeout: GH_TIMEOUT,
        maxOutputBytes: 1_000_000,
      });
      if (result.code !== 0 || result.timedOut) {
        yield* Effect.logWarning("gh pr view failed", {
          url,
          code: result.code,
          stderr: result.stderr.trim().slice(0, 500),
        });
        return Option.none();
      }
      const { headRefName, ...pr } = yield* decodeGhPullRequest(result.stdout);
      return Option.some<PullRequestText>(
        headRefName === undefined ? pr : { ...pr, headBranch: headRefName },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read pull request text", {
          url,
          cause,
        }).pipe(Effect.as(Option.none<PullRequestText>())),
      ),
    );

  return PullRequestTextReader.of({ read });
});

export const layer: Layer.Layer<PullRequestTextReader, never, ProcessRunner.ProcessRunner> =
  Layer.effect(PullRequestTextReader, make);

export const layerTest = (
  read: (url: string) => Option.Option<PullRequestText>,
): Layer.Layer<PullRequestTextReader> =>
  Layer.succeed(
    PullRequestTextReader,
    PullRequestTextReader.of({ read: (url) => Effect.sync(() => read(url)) }),
  );
