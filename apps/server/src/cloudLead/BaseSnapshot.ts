/**
 * The base snapshot holds the heavy, slow-changing parts of a cloud lead's
 * machine: pinned claude and pnpm, gh, the busyboy clone and its node_modules.
 * Its key is the claude version, the pnpm version and the pnpm-lock.yaml hash
 * of origin/main, so it is rebuilt only when one of those changes (or the
 * snapshot is gone). It is built from the exact origin/main commit whose
 * lockfile was hashed; a task branch's own dependency changes are installed on
 * top when its lead starts.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - effect/Crypto has no sync sha256; cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

import type { LocalHost } from "./LocalHost.ts";
import type { SandboxClient } from "./SandboxClient.ts";

export interface BaseSnapshotInputs {
  readonly claudeVersion: string;
  readonly pnpmVersion: string;
  readonly lockfileHash: string;
  /** The origin/main commit the lockfile came from; not part of the key. */
  readonly repoCommit: string;
}

export interface BaseSnapshotState extends BaseSnapshotInputs {
  readonly key: string;
  readonly snapshotId: string;
  readonly createdAt: string;
}

export const REPO_URL = "https://github.com/devjiwonchoi/busyboy.git";
export const REMOTE_REPO_DIR = "busyboy";
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
const BUILD_TIMEOUT_MS = 40 * 60 * 1000;

export const baseSnapshotKey = (inputs: BaseSnapshotInputs): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([inputs.claudeVersion, inputs.pnpmVersion, inputs.lockfileHash]))
    .digest("hex")
    .slice(0, 16);

const VERSION = /\d+\.\d+\.\d+/;
const COMMIT = /^[0-9a-f]{40}$/;
const BASE_REF = "origin/main";

const firstVersion = (tool: string, output: string) => {
  const version = output.match(VERSION)?.[0];
  // An empty version would turn the pinned install into "install the latest".
  if (version === undefined) throw new Error(`Could not read the local ${tool} version`);
  return version;
};

/** Pinned tool versions on this Mac, and the lockfile of origin/main with its commit. */
export const readLocalInputs = async (
  host: LocalHost,
  repoRoot: string,
): Promise<BaseSnapshotInputs> => {
  const git = (args: ReadonlyArray<string>) => host.exec("git", args, { cwd: repoRoot });
  const commit = (await git(["rev-parse", BASE_REF])).stdout.trim();
  if (!COMMIT.test(commit)) throw new Error(`Could not resolve ${BASE_REF} in ${repoRoot}`);
  const lockfile = await git(["show", `${commit}:pnpm-lock.yaml`]);
  if (lockfile.exitCode !== 0) throw new Error(`No pnpm-lock.yaml at ${BASE_REF}`);
  return {
    claudeVersion: firstVersion("claude", (await host.exec("claude", ["--version"])).stdout),
    // In the repo, so corepack reports the pinned pnpm, not the global one.
    pnpmVersion: firstVersion(
      "pnpm",
      (await host.exec("pnpm", ["--version"], { cwd: repoRoot })).stdout,
    ),
    lockfileHash: NodeCrypto.createHash("sha256").update(lockfile.stdout).digest("hex"),
    repoCommit: commit,
  };
};

export interface BaseSnapshotStore {
  readonly read: () => Promise<BaseSnapshotState | null>;
  readonly write: (state: BaseSnapshotState) => Promise<void>;
}

export const fileBaseSnapshotStore = (host: LocalHost, path: string): BaseSnapshotStore => ({
  read: async () => {
    const raw = await host.readFile(path);
    if (raw === null) return null;
    try {
      return JSON.parse(raw.toString("utf8")) as BaseSnapshotState;
    } catch {
      return null;
    }
  },
  write: (state) => host.writeFile(path, JSON.stringify(state, null, 2)),
});

/** The script that turns a fresh universal image into the base machine. Stderr is kept for errors. */
export const buildScript = (inputs: BaseSnapshotInputs): string => {
  // Validated, so they are safe to interpolate into the script.
  for (const version of [inputs.claudeVersion, inputs.pnpmVersion]) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version ${version}`);
  }
  if (!COMMIT.test(inputs.repoCommit)) throw new Error(`Invalid commit ${inputs.repoCommit}`);
  return [
    "set -e",
    `[ "$(claude --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1)" = "${inputs.claudeVersion}" ] || sudo npm i -g @anthropic-ai/claude-code@${inputs.claudeVersion} >/dev/null`,
    `[ "$(pnpm --version 2>/dev/null)" = "${inputs.pnpmVersion}" ] || sudo npm i -g pnpm@${inputs.pnpmVersion} >/dev/null`,
    "command -v gh >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq gh) >/dev/null",
    "hash -r",
    `rm -rf ~/${REMOTE_REPO_DIR}`,
    `git clone -q --filter=blob:none ${REPO_URL} ~/${REMOTE_REPO_DIR}`,
    `cd ~/${REMOTE_REPO_DIR} && git checkout -q --detach ${inputs.repoCommit}`,
    "pnpm install --frozen-lockfile >/dev/null",
    "claude --version; pnpm --version",
  ].join("\n");
};

export interface EnsureBaseSnapshotResult {
  readonly state: BaseSnapshotState;
  readonly reused: boolean;
  /** Why it was rebuilt, when it was. */
  readonly reason?: "none" | "key-changed" | "snapshot-missing";
}

export const ensureBaseSnapshot = async (input: {
  readonly client: SandboxClient;
  readonly store: BaseSnapshotStore;
  readonly inputs: BaseSnapshotInputs;
  readonly vcpus?: number;
  readonly now?: () => Date;
}): Promise<EnsureBaseSnapshotResult> => {
  const key = baseSnapshotKey(input.inputs);
  const previous = await input.store.read();
  let reason: EnsureBaseSnapshotResult["reason"] = "none";
  if (previous !== null && previous.key === key) {
    if ((await input.client.snapshotState(previous.snapshotId)) === "available") {
      return { state: previous, reused: true };
    }
    reason = "snapshot-missing";
  } else if (previous !== null) {
    reason = "key-changed";
  }

  const builder = await input.client.create({
    vcpus: input.vcpus ?? 4,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  try {
    await builder.sh(buildScript(input.inputs), { timeoutMs: BUILD_TIMEOUT_MS });
    // snapshot() stops the sandbox it was taken from.
    const snapshot = await builder.snapshot({ expirationMs: SNAPSHOT_EXPIRATION_MS });
    const state: BaseSnapshotState = {
      ...input.inputs,
      key,
      snapshotId: snapshot.snapshotId,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    await input.store.write(state);
    return { state, reused: false, reason };
  } finally {
    await builder.delete().catch(() => undefined);
  }
};
