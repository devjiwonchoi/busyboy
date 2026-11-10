import { describe, expect, it } from "vite-plus/test";

import {
  baseSnapshotKey,
  buildScript,
  ensureBaseSnapshot,
  fileBaseSnapshotStore,
  readLocalInputs,
  type BaseSnapshotInputs,
} from "./BaseSnapshot.ts";
import { fakeLocalHost, fakeSandboxClient } from "./testkit.ts";

const inputs: BaseSnapshotInputs = {
  claudeVersion: "2.1.311",
  pnpmVersion: "11.10.0",
  codexVersion: "0.167.0",
  lockfileHash: "lock-a",
  repoCommit: "a".repeat(40),
};
const STATE = "/base/cloud-lead/base-snapshot.json";

const setup = (snapshots: Record<string, "available" | "missing"> = {}) => {
  const host = fakeLocalHost({ files: {} });
  return { host, store: fileBaseSnapshotStore(host, STATE), client: fakeSandboxClient(snapshots) };
};

describe("baseSnapshotKey", () => {
  it("changes only with the claude version, pnpm version or lockfile hash", () => {
    const key = baseSnapshotKey(inputs);
    expect(baseSnapshotKey({ ...inputs })).toBe(key);
    expect(baseSnapshotKey({ ...inputs, claudeVersion: "2.1.312" })).not.toBe(key);
    expect(baseSnapshotKey({ ...inputs, pnpmVersion: "11.11.0" })).not.toBe(key);
    expect(baseSnapshotKey({ ...inputs, codexVersion: "0.168.0" })).not.toBe(key);
    expect(baseSnapshotKey({ ...inputs, lockfileHash: "lock-b" })).not.toBe(key);
  });
});

describe("ensureBaseSnapshot", () => {
  it("builds once, then reuses the snapshot while the key holds", async () => {
    const { store, client } = setup();
    const first = await ensureBaseSnapshot({ client, store, inputs });
    expect(first.reused).toBe(false);
    expect(client.created).toHaveLength(1);
    const script = String(client.created[0]?.commands[0]?.args?.[1]);
    expect(script).toContain("@anthropic-ai/claude-code@2.1.311");
    expect(script).toContain("pnpm@11.10.0");
    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain(`git checkout -q --detach ${"a".repeat(40)}`);
    expect(client.created[0]?.deleted()).toBe(true);

    const reuse = fakeSandboxClient({ [first.state.snapshotId]: "available" });
    const second = await ensureBaseSnapshot({ client: reuse, store, inputs });
    expect(second).toMatchObject({ reused: true, state: { snapshotId: first.state.snapshotId } });
    expect(reuse.created).toHaveLength(0);
  });

  it("rebuilds when the lockfile or claude version changes", async () => {
    const { store, client } = setup();
    const first = await ensureBaseSnapshot({ client, store, inputs });
    const available = { [first.state.snapshotId]: "available" as const };

    const lockChanged = fakeSandboxClient(available);
    const second = await ensureBaseSnapshot({
      client: lockChanged,
      store,
      inputs: { ...inputs, lockfileHash: "lock-b" },
    });
    expect(second).toMatchObject({ reused: false, reason: "key-changed" });
    expect(lockChanged.created).toHaveLength(1);

    const claudeChanged = fakeSandboxClient({ [second.state.snapshotId]: "available" });
    const third = await ensureBaseSnapshot({
      client: claudeChanged,
      store,
      inputs: { ...inputs, lockfileHash: "lock-b", claudeVersion: "2.1.400" },
    });
    expect(third.reason).toBe("key-changed");
    expect(String(claudeChanged.created[0]?.commands[0]?.args?.[1])).toContain(
      "@anthropic-ai/claude-code@2.1.400",
    );
  });

  it("rebuilds when the saved snapshot expired or was deleted", async () => {
    const { store, client } = setup();
    await ensureBaseSnapshot({ client, store, inputs });
    const gone = fakeSandboxClient();
    const result = await ensureBaseSnapshot({ client: gone, store, inputs });
    expect(result).toMatchObject({ reused: false, reason: "snapshot-missing" });
    expect(gone.created).toHaveLength(1);
  });
});

describe("readLocalInputs", () => {
  const commit = "b".repeat(40);
  const exec = {
    "claude --version": "2.1.311 (Claude Code)\n",
    "pnpm --version": "11.10.0\n",
    "codex --version": "codex-cli 0.167.0\n",
    "git rev-parse origin/main": `${commit}\n`,
    [`git show ${commit}:pnpm-lock.yaml`]: "lockfileVersion: 9",
  };

  it("reads versions and hashes the origin/main lockfile it will build from", async () => {
    const host = fakeLocalHost({ files: {}, exec });
    const read = await readLocalInputs(host, "/repo");
    expect(read.claudeVersion).toBe("2.1.311");
    expect(read.pnpmVersion).toBe("11.10.0");
    expect(read.codexVersion).toBe("0.167.0");
    expect(read.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(read.repoCommit).toBe(commit);
    // In the repo, so corepack reports the pinned pnpm rather than a global one.
    expect(host.execCalls).toContainEqual({ command: "pnpm --version", cwd: "/repo" });
  });

  it("refuses to build without a pinned version", async () => {
    const host = fakeLocalHost({ files: {}, exec: { ...exec, "claude --version": "" } });
    await expect(readLocalInputs(host, "/repo")).rejects.toThrow(/claude version/);
  });
});

describe("buildScript", () => {
  it("pins the Mac's codex for Codex children, and skips it when the Mac has none", () => {
    expect(buildScript(inputs)).toContain("npm i -g @openai/codex@0.167.0");
    expect(buildScript({ ...inputs, codexVersion: null })).not.toContain("codex");
  });
});
