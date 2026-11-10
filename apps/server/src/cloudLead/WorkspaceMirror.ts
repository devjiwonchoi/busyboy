// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * Copies a git working tree from one machine to another: the commits (as a git
 * bundle), the uncommitted tracked changes (a binary patch) and the untracked
 * files (a tarball). The target ends up with the same HEAD commit on its
 * current branch and the same files, ignored files aside.
 *
 * A cloud lead uses it both ways: Mac → sandbox when the lead starts, and
 * sandbox → Mac after every turn and before every checkpoint, so the Mac
 * worktree stays a faithful mirror that the review gate, diff, checkpoints and
 * PR linking read as usual.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";

import { shellQuote } from "./EnvironmentSync.ts";
import type { SandboxHandle } from "./SandboxClient.ts";

/** A machine the mirror can run git on. */
export interface MirrorShell {
  /** Runs a bash script and returns stdout; throws on a non-zero exit. */
  readonly run: (script: string) => Promise<string>;
  readonly readFile: (path: string) => Promise<Buffer | null>;
  readonly writeFile: (path: string, content: Buffer) => Promise<void>;
}

export interface WorkspaceState {
  readonly head: string;
  readonly bundle: Buffer | null;
  readonly patch: Buffer;
  readonly untracked: Buffer | null;
}

const COMMIT = /^[0-9a-f]{40}$/;

/** Inside the git dir, which in a linked worktree is not `<repo>/.git` (that is a file there). */
const stagingDir = async (shell: MirrorShell, repoDir: string) => {
  const gitDir = (await shell.run(`git -C ${shellQuote(repoDir)} rev-parse --absolute-git-dir`))
    .trim()
    .split("\n")
    .at(-1);
  if (gitDir === undefined || !gitDir.startsWith("/")) {
    throw new Error(`${repoDir} is not a git working tree.`);
  }
  return `${gitDir}/busyboy-mirror`;
};

/**
 * Captures `repoDir`. `knownCommit` is a commit the target already has; only
 * the commits after it go into the bundle.
 */
export const captureWorkspace = async (
  shell: MirrorShell,
  repoDir: string,
  knownCommit: string | null,
): Promise<WorkspaceState> => {
  const dir = await stagingDir(shell, repoDir);
  const repo = shellQuote(repoDir);
  const staging = shellQuote(dir);
  const out = await shell.run(
    [
      "set -euo pipefail",
      // The agent may be committing in this tree right now; reading it must not take index.lock.
      "export GIT_OPTIONAL_LOCKS=0",
      // macOS tar would add AppleDouble `._*` entries that unpack as stray files on Linux.
      "export COPYFILE_DISABLE=1",
      `cd ${repo}`,
      `rm -rf ${staging} && mkdir -p ${staging}`,
      "head=$(git rev-parse HEAD)",
      knownCommit === null
        ? `git bundle create ${staging}/commits.bundle HEAD >/dev/null 2>&1`
        : // Nothing new when HEAD is the known commit: skip the (refused) empty bundle.
          `if [ "$head" != ${shellQuote(knownCommit)} ]; then ` +
          `if git cat-file -e ${shellQuote(knownCommit)}^{commit} 2>/dev/null; then ` +
          `git bundle create ${staging}/commits.bundle HEAD --not ${shellQuote(knownCommit)} >/dev/null 2>&1; ` +
          `else git bundle create ${staging}/commits.bundle HEAD >/dev/null 2>&1; fi; fi`,
      `git diff --binary HEAD > ${staging}/changes.patch`,
      `git ls-files --others --exclude-standard -z > ${staging}/untracked.list`,
      `if [ -s ${staging}/untracked.list ]; then tar --null -T ${staging}/untracked.list -czf ${staging}/untracked.tgz; fi`,
      'echo "$head"',
    ].join("\n"),
  );
  const head = out.trim().split("\n").at(-1) ?? "";
  if (!COMMIT.test(head)) throw new Error(`Could not read HEAD in ${repoDir}`);
  const [bundle, patch, untracked] = await Promise.all([
    shell.readFile(`${dir}/commits.bundle`),
    shell.readFile(`${dir}/changes.patch`),
    shell.readFile(`${dir}/untracked.tgz`),
  ]);
  await shell.run(`rm -rf ${staging}`);
  return { head, bundle, patch: patch ?? Buffer.alloc(0), untracked };
};

/** Makes `repoDir` match a captured workspace. Ignored files (node_modules, builds) stay. */
export const applyWorkspace = async (
  shell: MirrorShell,
  repoDir: string,
  state: WorkspaceState,
  /** Check this branch out at the head first, e.g. on a fresh clone in detached HEAD. */
  branch?: string,
): Promise<void> => {
  if (!COMMIT.test(state.head)) throw new Error("Invalid workspace head.");
  const dir = await stagingDir(shell, repoDir);
  const repo = shellQuote(repoDir);
  const staging = shellQuote(dir);
  await shell.run(`mkdir -p ${staging}`);
  if (state.bundle !== null) await shell.writeFile(`${dir}/commits.bundle`, state.bundle);
  if (state.patch.length > 0) await shell.writeFile(`${dir}/changes.patch`, state.patch);
  if (state.untracked !== null) await shell.writeFile(`${dir}/untracked.tgz`, state.untracked);
  await shell.run(
    [
      "set -euo pipefail",
      `cd ${repo}`,
      state.bundle === null
        ? ":"
        : `git fetch --quiet --no-write-fetch-head ${staging}/commits.bundle ` +
          `+HEAD:refs/busyboy-mirror/head`,
      branch === undefined
        ? ":"
        : `git checkout --quiet --force -B ${shellQuote(branch)} ${state.head}`,
      `git reset --quiet --hard ${state.head}`,
      "git clean -fdq",
      state.patch.length === 0
        ? ":"
        : `git apply --index --binary --whitespace=nowarn ${staging}/changes.patch`,
      state.untracked === null ? ":" : `tar -xzf ${staging}/untracked.tgz`,
      "git update-ref -d refs/busyboy-mirror/head 2>/dev/null || true",
      `rm -rf ${staging}`,
    ].join("\n"),
  );
};

/** Copies `from` onto `to`. `knownCommit` is a commit `to` already has. */
export const mirrorWorkspace = async (input: {
  readonly from: MirrorShell;
  readonly fromDir: string;
  readonly to: MirrorShell;
  readonly toDir: string;
  readonly knownCommit: string | null;
  readonly branch?: string;
}): Promise<{ readonly head: string }> => {
  const state = await captureWorkspace(input.from, input.fromDir, input.knownCommit);
  await applyWorkspace(input.to, input.toDir, state, input.branch);
  return { head: state.head };
};

export const localMirrorShell = (): MirrorShell => ({
  run: (script) =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        "bash",
        ["-c", script],
        { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${String(stderr).slice(-2000)}`));
          } else {
            resolve(String(stdout));
          }
        },
      );
    }),
  readFile: (path) => NodeFs.readFile(path).catch(() => null),
  writeFile: (path, content) => NodeFs.writeFile(path, content),
});

export const sandboxMirrorShell = (sandbox: SandboxHandle): MirrorShell => ({
  run: (script) => sandbox.sh(script),
  readFile: (path) => sandbox.readFile(path),
  writeFile: (path, content) => sandbox.writeFiles([{ path, content }]),
});
