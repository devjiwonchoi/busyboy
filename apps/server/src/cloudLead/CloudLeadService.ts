// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * The Effect face of CloudLeadRuntime: what the Claude adapter and run
 * finalization call for cloud threads. The default (no layer provided) refuses
 * cloud threads with a clear message and does nothing for local ones.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ensureBaseSnapshot, fileBaseSnapshotStore, readLocalInputs } from "./BaseSnapshot.ts";
import * as CloudLeadSecrets from "./CloudLeadSecrets.ts";
import { CloudLeadRuntime, type CloudLaunch } from "./CloudLeadRuntime.ts";
import { joinPath, nodeLocalHost } from "./LocalHost.ts";
import { makeSandboxClient } from "./SandboxClient.ts";

export class CloudLeadError extends Schema.TaggedError<CloudLeadError>()("CloudLeadError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface CloudLeadHooksShape {
  readonly prepare: (input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly mcpEndpoint: string;
  }) => Effect.Effect<CloudLaunch, CloudLeadError>;
  /** Mirrors the sandbox onto the Mac worktree; a no-op without a live sandbox. */
  readonly syncToMac: (threadId: string) => Effect.Effect<void, CloudLeadError>;
  readonly release: (threadId: string) => Effect.Effect<void>;
}

const unavailable: CloudLeadHooksShape = {
  prepare: () =>
    Effect.fail(new CloudLeadError({ detail: "Cloud task leads are not available in this server." })),
  syncToMac: () => Effect.void,
  release: () => Effect.void,
};

export class CloudLeadHooks extends Context.Reference<CloudLeadHooksShape>(
  "t3/cloudLead/CloudLeadHooks",
  { defaultValue: () => unavailable },
) {}

const errorDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The hooks over a runtime; the server builds one from saved secrets, tests from fakes. */
export const hooksFromRuntime = (runtime: CloudLeadRuntime): CloudLeadHooksShape =>
  CloudLeadHooks.of({
    prepare: (input) =>
      Effect.tryPromise({
        try: () => runtime.prepare(input),
        catch: (cause) =>
          new CloudLeadError({ detail: `Could not start the cloud sandbox: ${errorDetail(cause)}` }),
      }).pipe(Effect.withSpan("CloudLeadHooks.prepare")),
    syncToMac: (threadId) =>
      Effect.tryPromise({
        try: () => runtime.syncToMac(threadId),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not copy the cloud sandbox's work to the Mac: ${errorDetail(cause)}`,
          }),
      }).pipe(Effect.asVoid, Effect.withSpan("CloudLeadHooks.syncToMac")),
    release: (threadId) => Effect.promise(() => runtime.release(threadId)),
  });

/** The Vercel CLI keeps its login token here on macOS; used when none was saved. */
const VERCEL_CLI_AUTH = "Library/Application Support/com.vercel.cli/auth.json";

const readVercelCliToken = async (home: string): Promise<string | null> => {
  try {
    const raw = await NodeFs.readFile(joinPath(home, VERCEL_CLI_AUTH), "utf8");
    const token = (JSON.parse(raw) as { token?: unknown }).token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
};

const ghAuthToken = () =>
  new Promise<string | null>((resolve) => {
    NodeChildProcess.execFile("gh", ["auth", "token"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error === null && String(stdout).trim().length > 0 ? String(stdout).trim() : null),
    );
  });

const BUSYBOY_REMOTE = /github\.com[:/]devjiwonchoi\/busyboy(\.git)?$/;

const make = Effect.gen(function* () {
  const secrets = yield* CloudLeadSecrets.CloudLeadSecrets;
  const config = yield* ServerConfig.ServerConfig;
  const home = nodeLocalHost.env.HOME ?? "";

  const read = (kind: Parameters<typeof secrets.read>[0]["kind"]) =>
    Effect.runPromise(
      secrets.read({ kind }).pipe(
        Effect.map(Option.map(Redacted.value)),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      ),
    );

  const runtime = new CloudLeadRuntime({
    host: nodeLocalHost,
    stateDir: config.stateDir,
    client: async () => {
      const [token, teamId, projectId] = await Promise.all([
        read("vercel_token").then(async (saved) => saved ?? (await readVercelCliToken(home))),
        read("vercel_team_id"),
        read("vercel_project_id"),
      ]);
      const missing = [
        token === null ? "vercel_token" : null,
        teamId === null ? "vercel_team_id" : null,
        projectId === null ? "vercel_project_id" : null,
      ].filter((kind) => kind !== null);
      if (missing.length > 0) {
        throw new Error(
          `Cloud leads need Vercel Sandbox access. Save ${missing.join(", ")} with request_secret and cloud_secret_save.`,
        );
      }
      return makeSandboxClient({
        token: Redacted.make(token!),
        teamId: teamId!,
        projectId: projectId!,
      });
    },
    credentials: async () => {
      const claudeOauthToken = await read("claude_oauth_token");
      if (claudeOauthToken === null) {
        throw new Error(
          "Cloud leads need a Claude setup-token. Run `claude setup-token`, then save it with request_secret and cloud_secret_save (kind claude_oauth_token).",
        );
      }
      const githubToken = (await read("github_token")) ?? (await ghAuthToken());
      return { claudeOauthToken, githubToken };
    },
    baseSnapshotId: async (client, worktreePath) => {
      const remote = await nodeLocalHost.exec("git", ["remote", "get-url", "origin"], {
        cwd: worktreePath,
      });
      if (!BUSYBOY_REMOTE.test(remote.stdout.trim())) {
        throw new Error(
          "Cloud leads run only in the busyboy repository for now: its base snapshot is a busyboy clone.",
        );
      }
      const result = await ensureBaseSnapshot({
        client,
        store: fileBaseSnapshotStore(
          nodeLocalHost,
          joinPath(config.stateDir, "cloud-lead-base-snapshot.json"),
        ),
        inputs: await readLocalInputs(nodeLocalHost, worktreePath),
      });
      return result.state.snapshotId;
    },
    log: (event, data) => Effect.runFork(Effect.logInfo(event, data)),
  });

  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.releaseAll()));

  return hooksFromRuntime(runtime);
});

export const layer = Layer.effect(CloudLeadHooks, make).pipe(
  Layer.provide(CloudLeadSecrets.layer),
);
