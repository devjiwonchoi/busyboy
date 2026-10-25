import * as GitHubRest from "@busyboy/source-control-github/server/GitHubRest";
import * as GitHubPullRequestApi from "@busyboy/source-control-github/server/GitHubPullRequestApi";
import * as GitHubDriver from "@busyboy/source-control-github/server/driver";
import type { SourceControlDriver } from "@busyboy/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const drivers = [GitHubDriver.driver];

export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

export const layer = Layer.mergeAll(
  // `GitHubRest.layerWithDependencies` carries the quota reserve and rate-limit pause every GitHub
  // reader shares, so the server builds it once, here.
  GitHubPullRequestApi.layer.pipe(Layer.provideMerge(GitHubRest.layerWithDependencies)),
).pipe(Layer.provideMerge(ServerSourceControlHost.layer));
