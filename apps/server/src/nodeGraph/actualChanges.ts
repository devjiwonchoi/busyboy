// @effect-diagnostics nodeBuiltinImport:off - a few bounded git reads; plain execFile keeps the adapter testable without platform layers.
import { execFile } from "node:child_process";

import type { NodeChanges, NodeExpectedFile } from "@t3tools/contracts";

import { compareChanges } from "./compute.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string | null>((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.toString()),
    );
  });

const lines = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** origin/HEAD when the clone has one, else a local main or master. */
const defaultBranch = async (cwd: string): Promise<string | null> => {
  const remoteHead = (
    await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  )?.trim();
  if (remoteHead) return remoteHead;
  for (const candidate of ["main", "master"]) {
    if ((await git(cwd, ["rev-parse", "--verify", "--quiet", candidate])) !== null)
      return candidate;
  }
  return null;
};

export type ChangedFiles =
  | { readonly kind: "files"; readonly base: string; readonly files: ReadonlyArray<string> }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Files changed in a checkout since it branched off the default branch: committed and
 * uncommitted tracked changes plus untracked files. Every record in the checkout shares it.
 */
export const changedFiles = async (cwd: string): Promise<ChangedFiles> => {
  if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") {
    return { kind: "unavailable", reason: "git 작업 폴더가 아닙니다." };
  }
  const branch = await defaultBranch(cwd);
  if (branch === null) {
    return { kind: "unavailable", reason: "기본 브랜치를 찾지 못했습니다." };
  }
  const base = (await git(cwd, ["merge-base", "HEAD", branch]))?.trim();
  if (!base) {
    return { kind: "unavailable", reason: `${branch}와의 분기점을 찾지 못했습니다.` };
  }
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", base]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (tracked === null || untracked === null) {
    return { kind: "unavailable", reason: "변경 파일 목록을 읽지 못했습니다." };
  }
  return {
    kind: "files",
    base: `${branch}@${base.slice(0, 12)}`,
    files: [...new Set([...lines(tracked), ...lines(untracked)])].toSorted(),
  };
};

/** Compares a record's expected file tree with its checkout's changed files. */
export const changesFor = (
  expected: ReadonlyArray<NodeExpectedFile>,
  changed: ChangedFiles,
): NodeChanges => {
  if (expected.length === 0) {
    return { kind: "unavailable", reason: "ALIGN.md에 파일 트리가 없습니다." };
  }
  if (changed.kind === "unavailable") return changed;
  return compareChanges(expected, changed.files, changed.base);
};

export const actualChanges = async (
  cwd: string,
  expected: ReadonlyArray<NodeExpectedFile>,
): Promise<NodeChanges> =>
  changesFor(
    expected,
    expected.length === 0 ? { kind: "files", base: "", files: [] } : await changedFiles(cwd),
  );
