import type {
  ProjectId,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";

/** What the Ready gate needs to know about a pull request. */
export interface PullRequestShipState {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly headSha: string | null;
  readonly mergeability: PullRequestMergeability;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly status: PullRequestCheckStatus;
  }>;
  /** Review threads nobody resolved yet. */
  readonly unresolvedThreads: number;
}

export class PullRequestShipGateError extends Data.TaggedError("PullRequestShipGateError")<{
  readonly message: string;
}> {}

export class PullRequestShipGate extends Context.Service<
  PullRequestShipGate,
  {
    /** The pull request's state; None when it can't be read. Never fails. */
    readonly read: (input: {
      readonly projectId: ProjectId;
      readonly url: string;
    }) => Effect.Effect<Option.Option<PullRequestShipState>>;
    /** Marks a draft pull request ready for review. */
    readonly markReady: (input: {
      readonly projectId: ProjectId;
      readonly url: string;
    }) => Effect.Effect<void, PullRequestShipGateError>;
  }
>()("t3/projectTeam/PullRequestShipGate") {}

const referenceOf = (projectId: ProjectId, url: string) => {
  const parsed = parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const key = normalizeThreadPullRequestKey(parsed);
  return { projectId, host: key.host, repository: key.repository, number: key.number };
};

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;

  const read: PullRequestShipGate["Service"]["read"] = ({ projectId, url }) =>
    Effect.gen(function* () {
      const reference = referenceOf(projectId, url);
      if (reference === null) return Option.none<PullRequestShipState>();
      // Fresh reads: a cached answer could hide the check that just failed.
      yield* pullRequests.invalidate({ reference });
      const [detail, activity] = yield* Effect.all(
        [
          pullRequests.detail({ ...reference, allowStale: false }),
          pullRequests.activity(reference),
        ],
        { concurrency: 2 },
      );
      return Option.some<PullRequestShipState>({
        state: detail.state,
        isDraft: detail.isDraft,
        headSha: detail.headSha ?? null,
        mergeability: detail.mergeability,
        checks: detail.checks.map((check) => ({ name: check.name, status: check.status })),
        unresolvedThreads: activity.reviewThreads.filter((thread) => !thread.isResolved).length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read the pull request for the Ready gate", {
          url,
          cause,
        }).pipe(Effect.as(Option.none<PullRequestShipState>())),
      ),
    );

  const markReady: PullRequestShipGate["Service"]["markReady"] = ({ projectId, url }) =>
    Effect.gen(function* () {
      const reference = referenceOf(projectId, url);
      if (reference === null) {
        return yield* new PullRequestShipGateError({
          message: `${url} is not a pull request URL.`,
        });
      }
      yield* pullRequests.runAction({ ...reference, action: "ready" });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not mark the pull request ready for review", {
          url,
          cause,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new PullRequestShipGateError({
                message: "The host refused to mark the pull request ready for review.",
              }),
            ),
          ),
        ),
      ),
    );

  return PullRequestShipGate.of({ read, markReady });
});

export const layer: Layer.Layer<PullRequestShipGate, never, PullRequestService.PullRequestService> =
  Layer.effect(PullRequestShipGate, make);

export const layerTest = (input: {
  readonly read: (url: string) => Option.Option<PullRequestShipState>;
  /** Returns an error message to refuse, or null to succeed. */
  readonly markReady: (url: string) => string | null;
}): Layer.Layer<PullRequestShipGate> =>
  Layer.succeed(
    PullRequestShipGate,
    PullRequestShipGate.of({
      read: ({ url }) => Effect.sync(() => input.read(url)),
      markReady: ({ url }) =>
        Effect.suspend(() => {
          const refused = input.markReady(url);
          return refused === null
            ? Effect.void
            : Effect.fail(new PullRequestShipGateError({ message: refused }));
        }),
    }),
  );
