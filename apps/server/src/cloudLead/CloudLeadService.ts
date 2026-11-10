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
import * as SqlClient from "effect/sql/SqlClient";

import { type ExecutionLocation, ThreadId } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ensureBaseSnapshot, fileBaseSnapshotStore, readLocalInputs } from "./BaseSnapshot.ts";
import * as CloudLeadSecrets from "./CloudLeadSecrets.ts";
import {
  CloudLeadRuntime,
  type CloudLaunch,
  type CodexCheck,
  type PrepareInput,
} from "./CloudLeadRuntime.ts";
import type { CloudSessionRecord, CloudSessionStore } from "./CloudSessionStore.ts";
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
  /** Threads in the same Mac worktree (a lead and its children) share one sandbox. */
  readonly prepare: (input: PrepareInput) => Effect.Effect<CloudLaunch, CloudLeadError>;
  /** Whether a Codex child can start in the live sandbox of a Mac worktree; never fails. */
  readonly checkCodex: (worktreePath: string) => Effect.Effect<CodexCheck>;
  /** Mirrors the sandbox onto the Mac worktree; a no-op without a live sandbox. */
  readonly syncToMac: (threadId: string) => Effect.Effect<void, CloudLeadError>;
  readonly release: (threadId: string) => Effect.Effect<void>;
  /** Packs the Mac's claude transcripts for a worktree into the thread's backup. */
  readonly importTranscripts: (input: {
    readonly threadId: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, CloudLeadError>;
  /** Unpacks the thread's transcript backup into the Mac's claude folder. */
  readonly exportTranscripts: (input: {
    readonly threadId: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, CloudLeadError>;
  /** Whether a claude session can resume at a location: the Mac folder, or the backup. */
  readonly hasTranscript: (input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly sessionId: string;
    readonly location: ExecutionLocation;
  }) => Effect.Effect<boolean, CloudLeadError>;
  /** How a sandbox replaced near its lifetime limit stops and resumes the lead's turn. */
  readonly setRotationHandler: (handler: RotationHandler) => Effect.Effect<void>;
}

export interface RotationHandler {
  /** True while the lead is being moved; a rotation then waits. */
  readonly busy: (threadId: ThreadId) => boolean;
  /** Stops the lead's running turn with its queue held; succeeds once the turn ended. */
  readonly interrupt: (threadId: ThreadId) => Effect.Effect<void>;
  /** Lets the held queue run again on the new sandbox. */
  readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
  /** The sandbox could not be replaced; the user decides what to do. */
  readonly failed: (threadId: ThreadId, reason: string) => Effect.Effect<void>;
}

/** No cloud runtime: cloud work fails, local work does nothing. Tests spread it. */
export const unavailableHooks: CloudLeadHooksShape = {
  prepare: () =>
    Effect.fail(
      new CloudLeadError({ detail: "Cloud task leads are not available in this server." }),
    ),
  checkCodex: () =>
    Effect.succeed({
      ok: false,
      reason: "cloud task leads are not available in this server",
      transient: false,
    }),
  syncToMac: () => Effect.void,
  release: () => Effect.void,
  importTranscripts: () =>
    Effect.fail(
      new CloudLeadError({ detail: "Cloud task leads are not available in this server." }),
    ),
  exportTranscripts: () => Effect.void,
  hasTranscript: () => Effect.succeed(false),
  setRotationHandler: () => Effect.void,
};

export class CloudLeadHooks extends Context.Reference<CloudLeadHooksShape>(
  "t3/cloudLead/CloudLeadHooks",
  { defaultValue: () => unavailableHooks },
) {}

const errorDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The hooks over a runtime; the server builds one from saved secrets, tests from fakes. */
export const hooksFromRuntime = (runtime: CloudLeadRuntime): CloudLeadHooksShape =>
  CloudLeadHooks.of({
    prepare: (input) =>
      Effect.tryPromise({
        try: () => runtime.prepare(input),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not start the cloud sandbox: ${errorDetail(cause)}`,
          }),
      }).pipe(Effect.withSpan("CloudLeadHooks.prepare")),
    checkCodex: (worktreePath) =>
      Effect.promise(() => runtime.checkCodex(worktreePath)).pipe(
        Effect.withSpan("CloudLeadHooks.checkCodex"),
      ),
    syncToMac: (threadId) =>
      Effect.tryPromise({
        try: () => runtime.syncToMac(threadId),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not copy the cloud sandbox's work to the Mac: ${errorDetail(cause)}`,
          }),
      }).pipe(Effect.asVoid, Effect.withSpan("CloudLeadHooks.syncToMac")),
    release: (threadId) => Effect.promise(() => runtime.release(threadId)),
    importTranscripts: ({ threadId, worktreePath }) =>
      Effect.tryPromise({
        try: () => runtime.importTranscripts(threadId, worktreePath),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not copy the claude transcripts for the sandbox: ${errorDetail(cause)}`,
          }),
      }).pipe(Effect.withSpan("CloudLeadHooks.importTranscripts")),
    exportTranscripts: ({ threadId, worktreePath }) =>
      Effect.tryPromise({
        try: () => runtime.exportTranscripts(threadId, worktreePath),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not copy the claude transcripts to the Mac: ${errorDetail(cause)}`,
          }),
      }).pipe(Effect.withSpan("CloudLeadHooks.exportTranscripts")),
    hasTranscript: ({ worktreePath, ...input }) =>
      Effect.tryPromise({
        try: () => runtime.hasTranscript({ ...input, macCwd: worktreePath }),
        catch: (cause) =>
          new CloudLeadError({
            detail: `Could not look for the transcript: ${errorDetail(cause)}`,
          }),
      }),
    setRotationHandler: (handler) =>
      Effect.sync(() =>
        runtime.setRotationHandler({
          busy: (threadId) => handler.busy(ThreadId.make(threadId)),
          interrupt: (threadId) => Effect.runPromise(handler.interrupt(ThreadId.make(threadId))),
          resume: (threadId) => Effect.runPromise(handler.resume(ThreadId.make(threadId))),
          failed: (threadId, reason) =>
            Effect.runPromise(handler.failed(ThreadId.make(threadId), reason)),
        }),
      ),
  });

/**
 * The Vercel CLI keeps its login token here on macOS; used when none was saved.
 * That token can reach every team the user belongs to, so makeSandboxClient
 * checks the team against ALLOWED_VERCEL_TEAM_SLUGS before any sandbox call.
 */
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

interface CloudSessionRow {
  readonly worktree_key: string;
  readonly thread_id: string;
  readonly sandbox_name: string;
  readonly sandbox_session_id: string | null;
  readonly relay_token_ref: string;
  readonly remote_home: string;
  readonly remote_cwd: string;
  readonly mcp_endpoint: string;
  readonly processes_json: string;
  readonly created_at: number;
}

/** Cloud sessions in the server database; relay bearers in the secret store. */
export const sqlCloudSessionStore = (
  sql: SqlClient.SqlClient,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): CloudSessionStore => ({
  list: () =>
    Effect.runPromise(
      sql<CloudSessionRow>`
        SELECT worktree_key, thread_id, sandbox_name, sandbox_session_id, relay_token_ref,
          remote_home, remote_cwd, mcp_endpoint, processes_json, created_at
        FROM cloud_lead_sessions
      `,
    ).then((rows) =>
      rows.map((row): CloudSessionRecord => ({
        worktreeKey: row.worktree_key,
        threadId: row.thread_id,
        sandboxName: row.sandbox_name,
        sandboxSessionId: row.sandbox_session_id,
        relayTokenRef: row.relay_token_ref,
        remoteHome: row.remote_home,
        remoteCwd: row.remote_cwd,
        mcpEndpoint: row.mcp_endpoint,
        processes: JSON.parse(row.processes_json) as CloudSessionRecord["processes"],
        createdAt: Number(row.created_at),
      })),
    ),
  save: (record) =>
    Effect.runPromise(
      sql`
        INSERT INTO cloud_lead_sessions (
          worktree_key, thread_id, sandbox_name, sandbox_session_id, relay_token_ref,
          remote_home, remote_cwd, mcp_endpoint, processes_json, created_at, updated_at
        ) VALUES (
          ${record.worktreeKey}, ${record.threadId}, ${record.sandboxName},
          ${record.sandboxSessionId}, ${record.relayTokenRef}, ${record.remoteHome},
          ${record.remoteCwd}, ${record.mcpEndpoint}, ${JSON.stringify(record.processes)},
          ${record.createdAt}, ${new Date().toISOString()}
        )
        ON CONFLICT (worktree_key) DO UPDATE SET
          thread_id = excluded.thread_id,
          sandbox_name = excluded.sandbox_name,
          sandbox_session_id = excluded.sandbox_session_id,
          relay_token_ref = excluded.relay_token_ref,
          remote_home = excluded.remote_home,
          remote_cwd = excluded.remote_cwd,
          mcp_endpoint = excluded.mcp_endpoint,
          processes_json = excluded.processes_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
    ).then(() => undefined),
  remove: (worktreeKey) =>
    Effect.runPromise(
      sql`DELETE FROM cloud_lead_sessions WHERE worktree_key = ${worktreeKey}`,
    ).then(() => undefined),
  saveToken: (ref, token) => Effect.runPromise(secrets.set(ref, new TextEncoder().encode(token))),
  readToken: (ref) =>
    Effect.runPromise(
      secrets
        .get(ref)
        .pipe(
          Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
          Effect.map(Option.getOrNull),
        ),
    ),
  removeToken: (ref) => Effect.runPromise(secrets.remove(ref)),
});

const make = Effect.gen(function* () {
  const secrets = yield* CloudLeadSecrets.CloudLeadSecrets;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
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
    store: sqlCloudSessionStore(sql, secretStore),
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
    codexAuth: {
      read: () => read("codex_auth_json"),
      save: (value) =>
        Effect.runPromise(secrets.save({ kind: "codex_auth_json", value }).pipe(Effect.asVoid)),
    },
    log: (event, data) => Effect.runFork(Effect.logInfo(event, data)),
  });

  // A stopping server lets its sandboxes run on; the next one attaches again.
  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.detachAll()));
  yield* Effect.forkDetach(
    Effect.promise(() => runtime.restore()).pipe(
      Effect.catchCause((cause) => Effect.logWarning("cloud-lead.restore-failed", { cause })),
    ),
  );

  return hooksFromRuntime(runtime);
});

export const layer = Layer.effect(CloudLeadHooks, make).pipe(Layer.provide(CloudLeadSecrets.layer));
