import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const layerSourceControlProviderRegistryTest = (input: {
  readonly process: Partial<VcsProcess.VcsProcess["Service"]>;
}) =>
  SourceControlProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        ServerSettings.ServerSettingsService.layerTest(),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
        Layer.mock(GitHubRest.GitHubRest)({}),
        // The GitHub provider's GraphQL reads go through these; no test here makes one.
        Layer.mock(GitHubRequestPolicy.GitHubRequestPolicy)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die(new Error("Unexpected GitHub GraphQL read"))),
        ),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(VcsProcess.VcsProcess)(input.process),
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(VcsProcess.VcsProcess)(input.process),
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
            ),
          ),
        ),
      ),
    ),
  );

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("reports implemented tools separately from locally available executables", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.command === "git") {
        return Effect.succeed(processOutput("git version 2.51.0\n"));
      }
      if (input.command === "gh" && input.args[0] === "--version") {
        return Effect.succeed(processOutput("gh version 2.83.0\n"));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "juliusmarminge",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      layerSourceControlProviderRegistryTest({
        process: processMock,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: SourceControlProviderKind.make("github"),
          status: "available",
          auth: "authenticated",
          account: Option.some("juliusmarminge"),
        },
      ],
    );
  }).pipe(Effect.provide(layerTest));
});

it.effect("probes provider authentication without exposing token details", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.args[0] === "--version") {
        return Effect.succeed(processOutput(`${input.command} version test\n`));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "octocat",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-auth-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      layerSourceControlProviderRegistryTest({
        process: processMock,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: SourceControlProviderKind.make("github"),
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(layerTest));
});
