import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "vite-plus/test";

import { makeLauncherScript } from "./local-app.mjs";

const scriptPath = NodePath.join(import.meta.dirname, "local-app.mjs");

function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commit(repo, message) {
  NodeFS.writeFileSync(NodePath.join(repo, "file.txt"), message);
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message]);
  git(repo, ["push", "--quiet", "origin", "HEAD:main"]);
}

describe("local app", () => {
  let tmp;
  let root;
  let author;
  let env;

  // A fake origin with two commits, slots a/b installed one commit behind it,
  // and a fake pnpm that fails the build when FAIL_BUILD is set.
  beforeEach(() => {
    tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-app-"));
    root = NodePath.join(tmp, "source");
    const origin = NodePath.join(tmp, "origin.git");
    author = NodePath.join(tmp, "author");
    git(tmp, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    git(tmp, ["clone", "--quiet", origin, author]);
    commit(author, "first");

    git(tmp, ["clone", "--quiet", origin, NodePath.join(root, "a")]);
    git(NodePath.join(root, "a"), ["checkout", "--quiet", "--detach", "origin/main"]);
    git(NodePath.join(root, "a"), [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      "../b",
      "origin/main",
    ]);
    NodeFS.symlinkSync("a", NodePath.join(root, "current"));
    commit(author, "second");

    const bin = NodePath.join(tmp, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "pnpm"),
      '#!/bin/sh\necho "pnpm $*"\nif [ "$1" = build ] && [ -n "$FAIL_BUILD" ]; then exit 1; fi\n',
      { mode: 0o755 },
    );
    env = {
      ...process.env,
      HOME: tmp,
      PATH: `${bin}:${process.env.PATH}`,
      T3CODE_LOCAL_APP_ROOT: root,
    };
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (command, extraEnv = {}) =>
    NodeChildProcess.spawnSync(process.execPath, [scriptPath, command], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
    });
  const lines = (stdout) =>
    stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const currentSlot = () => NodePath.basename(NodeFS.realpathSync(NodePath.join(root, "current")));

  it("reports commits on origin/main that the current slot lacks", () => {
    const result = run("check");

    assert.strictEqual(result.status, 0, result.stderr);
    const [report] = lines(result.stdout);
    assert.deepStrictEqual(report.commits, ["second"]);
    assert.strictEqual(report.latestCommit, git(author, ["rev-parse", "HEAD"]));
    assert.notStrictEqual(report.currentCommit, report.latestCommit);
  });

  it("builds origin/main in the idle slot and switches to it", () => {
    const prepare = run("prepare");

    assert.strictEqual(prepare.status, 0, prepare.stderr);
    const progress = lines(prepare.stdout);
    assert.deepStrictEqual(
      progress.map((line) => line.phase),
      ["fetch", "checkout", "install", "build", "done"],
    );
    assert.strictEqual(currentSlot(), "a");
    assert.strictEqual(
      git(NodePath.join(root, "b"), ["rev-parse", "HEAD"]),
      git(author, ["rev-parse", "HEAD"]),
    );
    assert.include(NodeFS.readFileSync(NodePath.join(root, "update.log"), "utf8"), "pnpm build");

    const switched = run("switch");

    assert.strictEqual(switched.status, 0, switched.stderr);
    assert.deepStrictEqual(lines(switched.stdout)[0], {
      slot: "b",
      commit: git(author, ["rev-parse", "HEAD"]),
      bundleRebuilt: false,
    });
    assert.strictEqual(currentSlot(), "b");
  });

  it("keeps the current slot when the build fails", () => {
    const prepare = run("prepare", { FAIL_BUILD: "1" });

    assert.strictEqual(prepare.status, 1);
    assert.include(prepare.stderr, "pnpm build failed");
    assert.include(prepare.stderr, "update.log");
    assert.strictEqual(currentSlot(), "a");

    const switched = run("switch");

    assert.strictEqual(switched.status, 1);
    assert.include(switched.stderr, "No prepared update");
    assert.strictEqual(currentSlot(), "a");
  });

  it("refuses to build over local changes in the idle slot", () => {
    NodeFS.writeFileSync(NodePath.join(root, "b", "file.txt"), "edited");

    const prepare = run("prepare");

    assert.strictEqual(prepare.status, 1);
    assert.include(prepare.stderr, "has local changes");
  });

  it("launches the slot that current points at", () => {
    const script = makeLauncherScript("/Users/me/.busyboy/source");

    assert.include(script, "root='/Users/me/.busyboy/source'");
    assert.include(script, 'slot=$(cd "$root/current" && pwd -P) || exit 1');
    assert.include(script, 'export T3CODE_LOCAL_APP_LAUNCHER="$0"');
    assert.include(
      script,
      'exec "$(dirname "$0")/Electron" "$slot/apps/desktop" "$@"',
    );
  });
});
