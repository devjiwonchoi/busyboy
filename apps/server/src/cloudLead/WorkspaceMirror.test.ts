// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodeZlib from "node:zlib";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { captureWorkspace, localMirrorShell, mirrorWorkspace } from "./WorkspaceMirror.ts";

const shell = localMirrorShell();
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await NodeFs.rm(dir, { recursive: true, force: true });
});

const git = (dir: string, script: string) =>
  shell.run(
    `cd '${dir}' && export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t && ${script}`,
  );

/** A "Mac" repo and a "sandbox" clone of it, both on the same commit. */
const twoRepos = async () => {
  const root = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/mirror-`);
  dirs.push(root);
  const mac = `${root}/mac`;
  const sandbox = `${root}/sandbox`;
  await shell.run(`mkdir -p '${mac}' && cd '${mac}' && git init -q -b task`);
  await git(
    mac,
    "printf 'node_modules\\n' > .gitignore && echo one > a.txt && echo keep > b.txt && git add . && git commit -qm base",
  );
  await shell.run(`git clone -q '${mac}' '${sandbox}' && cd '${sandbox}' && git checkout -q task`);
  const base = (await git(mac, "git rev-parse HEAD")).trim();
  return { mac, sandbox, base };
};

const read = (path: string) => NodeFs.readFile(path, "utf8").catch(() => null);

describe("mirrorWorkspace", () => {
  it("copies sandbox commits, uncommitted edits and untracked files onto the Mac", async () => {
    const { mac, sandbox, base } = await twoRepos();
    await git(sandbox, "echo two > a.txt && git commit -qam 'Change a' && echo three > c.txt");
    await git(sandbox, "git add c.txt && git commit -qm 'Add c'");
    // Uncommitted: a tracked edit, a staged deletion, a binary and an untracked file.
    await git(
      sandbox,
      "echo edited >> a.txt && git rm -q b.txt && printf '\\x00\\x01\\x02' > bin.dat && git add bin.dat && mkdir -p new && echo u > new/u.txt",
    );
    await shell.run(`mkdir -p '${mac}/node_modules' && echo dep > '${mac}/node_modules/x.js'`);

    const { head } = await mirrorWorkspace({
      from: shell,
      fromDir: sandbox,
      to: shell,
      toDir: mac,
      knownCommit: base,
    });

    expect((await git(mac, "git rev-parse HEAD")).trim()).toBe(head);
    expect((await git(mac, "git log --format=%s -3")).trim().split("\n")).toEqual([
      "Add c",
      "Change a",
      "base",
    ]);
    expect(await read(`${mac}/a.txt`)).toBe("two\nedited\n");
    expect(await read(`${mac}/b.txt`)).toBeNull();
    expect(await read(`${mac}/new/u.txt`)).toBe("u\n");
    expect(await NodeFs.readFile(`${mac}/bin.dat`)).toEqual(Buffer.from([0, 1, 2]));
    expect(await read(`${mac}/node_modules/x.js`)).toBe("dep\n");
    // Uncommitted changes land staged on the Mac; the diff against HEAD is the same.
    const changes = "git diff HEAD --name-status && git ls-files --others --exclude-standard";
    expect(await git(mac, changes)).toBe(await git(sandbox, changes));
  });

  it("drops stale Mac edits and follows a rewritten sandbox history", async () => {
    const { mac, sandbox, base } = await twoRepos();
    await git(sandbox, "echo two > a.txt && git commit -qam first");
    await mirrorWorkspace({ from: shell, fromDir: sandbox, to: shell, toDir: mac, knownCommit: base });
    const first = (await git(mac, "git rev-parse HEAD")).trim();

    await git(mac, "echo stray > stray.txt && echo stray >> a.txt");
    await git(sandbox, "echo amended > a.txt && git commit -q --amend -am amended");
    await mirrorWorkspace({
      from: shell,
      fromDir: sandbox,
      to: shell,
      toDir: mac,
      knownCommit: first,
    });

    expect((await git(mac, "git log --format=%s -1")).trim()).toBe("amended");
    expect(await read(`${mac}/a.txt`)).toBe("amended\n");
    expect(await read(`${mac}/stray.txt`)).toBeNull();
    expect(await git(mac, "git status --porcelain")).toBe("");
  });

  it("is a no-op bundle when nothing was committed", async () => {
    const { mac, sandbox, base } = await twoRepos();
    await git(sandbox, "echo wip >> a.txt");
    const { head } = await mirrorWorkspace({
      from: shell,
      fromDir: sandbox,
      to: shell,
      toDir: mac,
      knownCommit: base,
    });
    expect(head).toBe(base);
    expect(await read(`${mac}/a.txt`)).toBe("one\nwip\n");
  });

  it.runIf(process.platform === "darwin")(
    "packs untracked files without macOS metadata entries",
    async () => {
      const { mac, base } = await twoRepos();
      await git(mac, "echo new > new.txt && xattr -w com.apple.provenance x new.txt");
      const state = await captureWorkspace(shell, mac, base);
      // macOS tar -t hides AppleDouble entries, so read the raw archive like Linux tar would.
      const raw = NodeZlib.gunzipSync(state.untracked!).toString("latin1");
      expect(raw).toContain("new.txt");
      expect(raw).not.toContain("._new.txt");
    },
  );

  it("works in linked worktrees, whose .git is a file", async () => {
    const { mac, sandbox, base } = await twoRepos();
    const linked = `${mac}-linked`;
    dirs.push(linked);
    await git(mac, `git worktree add -q -b lead '${linked}' ${base}`);
    await git(sandbox, "echo two > a.txt && git commit -qam 'Change a'");
    const { head } = await mirrorWorkspace({
      from: shell,
      fromDir: sandbox,
      to: shell,
      toDir: linked,
      knownCommit: base,
    });
    expect((await git(linked, "git rev-parse HEAD")).trim()).toBe(head);
    expect(await read(`${linked}/a.txt`)).toBe("two\n");
    // And back out of the linked worktree.
    await git(linked, "echo three > a.txt");
    await mirrorWorkspace({ from: shell, fromDir: linked, to: shell, toDir: sandbox, knownCommit: head });
    expect(await read(`${sandbox}/a.txt`)).toBe("three\n");
  });
});
