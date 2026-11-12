// @effect-diagnostics globalDate:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * A thin, secret-safe wrapper over @vercel/sandbox.
 *
 * Secrets reach the sandbox only as runCommand env. Everything that comes back
 * (stdout, stderr, errors) is masked against every secret this client has
 * seen, and writeFiles refuses content that holds one.
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";
import * as Redacted from "effect/Redacted";

import { containsSecret, makeSecretMasker, type SecretMasker } from "./secretMask.ts";
import {
  assertAllowedVercelTeam,
  fetchVercelTeamInfo,
  VercelTeamNotAllowedError,
  type VercelTeamInfo,
  type VercelTeamQuery,
} from "./vercelTeamGuard.ts";

export interface SandboxCredentials {
  readonly token: Redacted.Redacted<string>;
  readonly teamId: string;
  readonly projectId: string;
}

export interface RunCommandInput {
  readonly cmd: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  /** The only way a secret may reach the sandbox. */
  readonly env?: Readonly<Record<string, string>>;
  readonly sudo?: boolean;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxFile {
  readonly path: string;
  readonly content: Buffer;
}

export interface SandboxHandle {
  readonly name: string;
  /** The running session; the relay extends and stops the sandbox through it. */
  readonly sessionId: string;
  /** When the session stops unless extended, if known. */
  readonly expiresAt: number | undefined;
  readonly runCommand: (input: RunCommandInput) => Promise<CommandResult>;
  /** Runs `bash -lc <script>` and throws (masked) on a non-zero exit. */
  readonly sh: (script: string, options?: Omit<RunCommandInput, "cmd" | "args">) => Promise<string>;
  readonly writeFiles: (files: ReadonlyArray<SandboxFile>) => Promise<void>;
  /** Starts a long-running command and returns once it started; output is not kept. */
  readonly startDetached: (input: RunCommandInput) => Promise<void>;
  /** Pushes the sandbox's stop time back by this much. */
  readonly extendTimeout: (ms: number) => Promise<void>;
  /** The public https origin of an exposed port, without a trailing slash. */
  readonly domain: (port: number) => string;
  readonly readFile: (path: string) => Promise<Buffer | null>;
  readonly snapshot: (input: { readonly expirationMs: number }) => Promise<{
    readonly snapshotId: string;
    readonly sizeBytes: number;
  }>;
  readonly stop: () => Promise<void>;
  readonly delete: () => Promise<void>;
}

export interface CreateSandboxInput {
  readonly name?: string;
  readonly snapshotId?: string;
  readonly vcpus: number;
  readonly timeoutMs: number;
  readonly persistent?: boolean;
  /** Ports to expose on a public https domain. */
  readonly ports?: ReadonlyArray<number>;
}

export type SnapshotState = "available" | "missing";

/** "running" also covers starting; "stopped" keeps a persistent sandbox's files. */
export type SandboxStatus = "running" | "stopped" | "missing";

/**
 * A Vercel token that reaches only this client's sandbox project (an OIDC
 * token scoped to the team and project). The relay holds it to keep its own
 * sandbox alive; the Mac's own token never leaves the Mac.
 */
export interface RelayVercelCredential {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  /** When the token stops working, in epoch ms. */
  readonly expiresAt: number;
}

export interface SandboxClient {
  readonly create: (input: CreateSandboxInput) => Promise<SandboxHandle>;
  readonly get: (name: string, options?: { readonly resume?: boolean }) => Promise<SandboxHandle>;
  /** Reads a sandbox's state without resuming it. */
  readonly status: (name: string) => Promise<SandboxStatus>;
  readonly relayCredential: () => Promise<RelayVercelCredential>;
  readonly snapshotState: (snapshotId: string) => Promise<SnapshotState>;
  readonly masker: () => SecretMasker;
}

/** The parts of the SDK this client uses; tests pass a fake. */
export interface SandboxSdk {
  readonly createSandbox: (params: Record<string, unknown>) => Promise<SdkSandbox>;
  readonly getSandbox: (params: Record<string, unknown>) => Promise<SdkSandbox>;
  readonly getSnapshot: (params: Record<string, unknown>) => Promise<SdkSnapshot>;
  /** Reads the team slug and project owner; checked before any sandbox call. */
  readonly lookupTeam: (query: VercelTeamQuery) => Promise<VercelTeamInfo>;
  /** Mints a project-scoped OIDC token (as `vercel env pull` does). */
  readonly mintProjectToken: (query: VercelTeamQuery) => Promise<string>;
}

export interface SdkSnapshot {
  readonly snapshotId: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly expiresAt?: Date | undefined;
}

export interface SdkSandbox {
  readonly name: string;
  readonly status: string;
  readonly expiresAt?: Date | undefined;
  currentSession(): { readonly sessionId: string };
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    signal?: AbortSignal;
    detached?: boolean;
  }): Promise<{ exitCode: number | null; stdout(): Promise<string>; stderr(): Promise<string> }>;
  domain(port: number): string;
  extendTimeout(duration: number): Promise<void>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  snapshot(opts?: { expiration?: number }): Promise<SdkSnapshot>;
  stop(): Promise<unknown>;
  delete(): Promise<unknown>;
}

export const vercelSandboxSdk: SandboxSdk = {
  createSandbox: (params) => Sandbox.create(params as never) as unknown as Promise<SdkSandbox>,
  getSandbox: (params) => Sandbox.get(params as never) as unknown as Promise<SdkSandbox>,
  getSnapshot: (params) => Snapshot.get(params as never) as unknown as Promise<SdkSnapshot>,
  lookupTeam: fetchVercelTeamInfo,
  mintProjectToken: async (query) => {
    const response = await fetch(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(query.projectId)}/token?source=vercel-oidc-refresh&teamId=${encodeURIComponent(query.teamId)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${query.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(`Vercel API answered ${response.status} for the project token`);
    const token = ((await response.json()) as { token?: unknown }).token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Vercel API returned no project token");
    }
    return token;
  },
};

/** Reads a JWT's claims without checking it; the token came straight from Vercel. */
const jwtClaims = (token: string): Record<string, unknown> => {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const makeSandboxClient = (
  credentials: SandboxCredentials,
  sdk: SandboxSdk = vercelSandboxSdk,
): SandboxClient => {
  const secrets = new Set<string>([Redacted.value(credentials.token)]);
  const masker = () => makeSecretMasker([...secrets]);
  const sdkCredentials = () => ({
    token: Redacted.value(credentials.token),
    teamId: credentials.teamId,
    projectId: credentials.projectId,
  });

  const guarded = async <A>(run: () => Promise<A>): Promise<A> => {
    try {
      return await run();
    } catch (error) {
      throw masker().maskError(error);
    }
  };

  // Every call that reaches Vercel waits for the team check first. A passed
  // check is kept; a failed one is retried on the next call.
  let teamChecked: Promise<void> | null = null;
  const checkTeam = () => {
    teamChecked ??= assertAllowedVercelTeam(sdkCredentials(), sdk.lookupTeam).catch((error) => {
      teamChecked = null;
      throw error;
    });
    return teamChecked;
  };

  const wrap = (sandbox: SdkSandbox): SandboxHandle => {
    const runCommand: SandboxHandle["runCommand"] = (input) =>
      guarded(async () => {
        for (const value of Object.values(input.env ?? {})) secrets.add(value);
        const signal =
          input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs);
        const finished = await sandbox.runCommand({
          cmd: input.cmd,
          ...(input.args === undefined ? {} : { args: [...input.args] }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.env === undefined ? {} : { env: { ...input.env } }),
          ...(input.sudo === undefined ? {} : { sudo: input.sudo }),
          ...(signal === undefined ? {} : { signal }),
        });
        const mask = masker().mask;
        return {
          exitCode: finished.exitCode ?? -1,
          stdout: mask(await finished.stdout()),
          stderr: mask(await finished.stderr()),
        };
      });

    return {
      name: sandbox.name,
      // A persistent sandbox resumed by a later call has a new session.
      get sessionId() {
        return sandbox.currentSession().sessionId;
      },
      get expiresAt() {
        return sandbox.expiresAt?.getTime();
      },
      runCommand,
      sh: async (script, options = {}) => {
        const result = await runCommand({ ...options, cmd: "bash", args: ["-lc", script] });
        if (result.exitCode !== 0) {
          const firstLine = masker()
            .mask(script.split("\n")[0] ?? "")
            .slice(0, 120);
          throw new Error(
            `Sandbox command failed (exit ${result.exitCode}): ${firstLine}\n${result.stderr.slice(-2000)}`,
          );
        }
        return result.stdout;
      },
      writeFiles: (files) =>
        guarded(async () => {
          for (const file of files) {
            if (containsSecret(file.content.toString("utf8"), [...secrets])) {
              throw new Error(`Refusing to write a secret into ${file.path}; pass it as env.`);
            }
          }
          await sandbox.writeFiles(
            files.map((file) => ({ path: file.path, content: file.content })),
          );
        }),
      startDetached: (input) =>
        guarded(async () => {
          for (const value of Object.values(input.env ?? {})) secrets.add(value);
          await sandbox.runCommand({
            cmd: input.cmd,
            ...(input.args === undefined ? {} : { args: [...input.args] }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.env === undefined ? {} : { env: { ...input.env } }),
            ...(input.sudo === undefined ? {} : { sudo: input.sudo }),
            detached: true,
          });
        }),
      domain: (port) => sandbox.domain(port).replace(/\/$/, ""),
      extendTimeout: (ms) => guarded(() => sandbox.extendTimeout(ms)),
      readFile: (path) => guarded(() => sandbox.readFileToBuffer({ path })),
      snapshot: ({ expirationMs }) =>
        guarded(async () => {
          const snapshot = await sandbox.snapshot({ expiration: expirationMs });
          return { snapshotId: snapshot.snapshotId, sizeBytes: snapshot.sizeBytes };
        }),
      stop: () => guarded(async () => void (await sandbox.stop())),
      delete: () => guarded(async () => void (await sandbox.delete())),
    };
  };

  return {
    create: (input) =>
      guarded(async () => {
        await checkTeam();
        return wrap(
          await sdk.createSandbox({
            ...sdkCredentials(),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.snapshotId === undefined
              ? {}
              : { source: { type: "snapshot", snapshotId: input.snapshotId } }),
            ...(input.persistent === undefined ? {} : { persistent: input.persistent }),
            ...(input.ports === undefined ? {} : { ports: [...input.ports] }),
            resources: { vcpus: input.vcpus },
            timeout: input.timeoutMs,
          }),
        );
      }),
    get: (name, options = {}) =>
      guarded(async () => {
        await checkTeam();
        return wrap(
          await sdk.getSandbox({
            ...sdkCredentials(),
            name,
            ...(options.resume === undefined ? {} : { resume: options.resume }),
          }),
        );
      }),
    status: (name) =>
      guarded(async () => {
        await checkTeam();
        let sandbox: SdkSandbox;
        try {
          sandbox = await sdk.getSandbox({ ...sdkCredentials(), name, resume: false });
        } catch (error) {
          if ((error as { response?: { status?: number } }).response?.status === 404) {
            return "missing";
          }
          throw error;
        }
        return sandbox.status === "running" || sandbox.status === "pending"
          ? "running"
          : sandbox.status === "failed" || sandbox.status === "aborted"
            ? "missing"
            : "stopped";
      }),
    relayCredential: () =>
      guarded(async () => {
        await checkTeam();
        const token = await sdk.mintProjectToken(sdkCredentials());
        // Fail closed: a token for any other team or project never reaches a sandbox.
        const claims = jwtClaims(token);
        if (claims.owner_id !== credentials.teamId || claims.project_id !== credentials.projectId) {
          throw new VercelTeamNotAllowedError("the project token is for another team or project");
        }
        secrets.add(token);
        return {
          token,
          teamId: credentials.teamId,
          projectId: credentials.projectId,
          expiresAt:
            typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 60 * 60 * 1000,
        };
      }),
    snapshotState: (snapshotId) =>
      guarded(async () => {
        await checkTeam();
        const snapshot = await sdk
          .getSnapshot({ ...sdkCredentials(), snapshotId })
          .catch(() => null);
        if (snapshot === null || snapshot.status !== "created") return "missing";
        if (snapshot.expiresAt !== undefined && snapshot.expiresAt.getTime() <= Date.now()) {
          return "missing";
        }
        return "available";
      }),
    masker,
  };
};
