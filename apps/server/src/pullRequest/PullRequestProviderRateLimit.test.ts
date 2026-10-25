import { SourceControlProviderKind } from "@busyboy/contracts";
import { assert, it } from "@effect/vitest";

import * as GitHubRest from "@busyboy/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@busyboy/source-control-github/server/GitHubRequestPolicy";
import * as SourceControlRateLimit from "@busyboy/source-control-core/server/SourceControlRateLimit";
import { gitHubProviderFailure } from "@busyboy/source-control-github/server/GitHubPullRequestProvider";

const cause = new Error("redacted provider failure");

it("classifies GitHub rate limits", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new GitHubRequestPolicy.GitHubApiRateLimitError({ host: "github.com", operation: "execute" }),
    ),
    { reason: "rate-limited" },
  );
});

it("keeps GitHub's exact retry time", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        retryAt: 1_786_802_400_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 1_786_802_400_000 },
  );
});
