// @effect-diagnostics globalDate:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
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
  readonly runCommand: (input: RunCommandInput) => Promise<CommandResult>;
  /** Runs `bash -lc <script>` and throws (masked) on a non-zero exit. */
  readonly sh: (script: string, options?: Omit<RunCommandInput, "cmd" | "args">) => Promise<string>;
  readonly writeFiles: (files: ReadonlyArray<SandboxFile>) => Promise<void>;
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
}

export type SnapshotState = "available" | "missing";

export interface SandboxClient {
  readonly create: (input: CreateSandboxInput) => Promise<SandboxHandle>;
  readonly get: (name: string, options?: { readonly resume?: boolean }) => Promise<SandboxHandle>;
  readonly snapshotState: (snapshotId: string) => Promise<SnapshotState>;
  readonly masker: () => SecretMasker;
}

/** The parts of the SDK this client uses; tests pass a fake. */
export interface SandboxSdk {
  readonly createSandbox: (params: Record<string, unknown>) => Promise<SdkSandbox>;
  readonly getSandbox: (params: Record<string, unknown>) => Promise<SdkSandbox>;
  readonly getSnapshot: (params: Record<string, unknown>) => Promise<SdkSnapshot>;
}

export interface SdkSnapshot {
  readonly snapshotId: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly expiresAt?: Date | undefined;
}

export interface SdkSandbox {
  readonly name: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number | null; stdout(): Promise<string>; stderr(): Promise<string> }>;
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
      guarded(async () =>
        wrap(
          await sdk.createSandbox({
            ...sdkCredentials(),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.snapshotId === undefined
              ? {}
              : { source: { type: "snapshot", snapshotId: input.snapshotId } }),
            ...(input.persistent === undefined ? {} : { persistent: input.persistent }),
            resources: { vcpus: input.vcpus },
            timeout: input.timeoutMs,
          }),
        ),
      ),
    get: (name, options = {}) =>
      guarded(async () =>
        wrap(
          await sdk.getSandbox({
            ...sdkCredentials(),
            name,
            ...(options.resume === undefined ? {} : { resume: options.resume }),
          }),
        ),
      ),
    snapshotState: (snapshotId) =>
      guarded(async () => {
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
