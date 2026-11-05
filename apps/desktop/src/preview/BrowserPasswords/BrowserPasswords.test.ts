// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { makeBrowserPasswords } from "./BrowserPasswords.ts";
import type { DeviceAuthRequest } from "./DeviceAuth.ts";
import { makeTestCipher } from "./testCipher.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { encryption?: boolean; approve?: boolean } = {}) {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-passwords-"));
  const rootDirectory = NodePath.join(directory, "BrowserPasswords");
  const cipher = makeTestCipher();
  const prompts: DeviceAuthRequest[] = [];
  let approve = options.approve ?? true;
  let clipboardText = "";
  const timers: Array<{ ms: number; run: () => void }> = [];
  const passwords = makeBrowserPasswords({
    rootDirectory,
    cipher: () => (options.encryption === false ? null : cipher),
    gate: {
      touchIdAvailable: () => true,
      authorize: (request) => {
        prompts.push(request);
        return Promise.resolve(approve);
      },
    },
    clipboard: {
      writeText: (text) => {
        clipboardText = text;
      },
      readText: () => Promise.resolve(clipboardText),
      clear: () => {
        clipboardText = "";
      },
    },
    now: () => 1_000,
    setTimeout: (run, ms) => timers.push({ ms, run }),
  });
  cleanups.push(() => {
    passwords.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const addAlice = () =>
    run(
      passwords.add({
        profileId: "default",
        url: "https://example.com/login?next=/",
        username: "alice",
        password: "correct-horse",
      }),
    );
  return {
    passwords,
    rootDirectory,
    prompts,
    timers,
    run,
    addAlice,
    clipboard: () => clipboardText,
    setClipboard: (text: string) => {
      clipboardText = text;
    },
    setApprove: (next: boolean) => {
      approve = next;
    },
  };
}

describe("BrowserPasswords", () => {
  it("is off with a reason, and writes nothing, when encryption is unavailable", async () => {
    const t = setup({ encryption: false });
    expect(await t.run(t.passwords.status("default"))).toEqual({
      available: false,
      reason: "encryptionUnavailable",
      touchIdAvailable: true,
    });
    const failure = await t.run(
      Effect.flip(
        t.passwords.add({ profileId: "default", url: "example.com", username: "a", password: "b" }),
      ),
    );
    expect(failure._tag).toBe("BrowserPasswordsUnavailableError");
    expect(NodeFs.existsSync(t.rootDirectory)).toBe(false);
  });

  it("never opens a vault for incognito", async () => {
    const t = setup();
    expect(await t.run(t.passwords.status("incognito"))).toMatchObject({
      available: false,
      reason: "incognito",
    });
    const failure = await t.run(Effect.flip(t.passwords.list({ profileId: "incognito" })));
    expect(failure._tag).toBe("BrowserPasswordsUnavailableError");
  });

  it("asks for Touch ID on every reveal and copy, and never for listing", async () => {
    const t = setup();
    const added = await t.addAlice();
    expect(added).toEqual({ kind: "added", id: 1 });

    expect(await t.run(t.passwords.list({ profileId: "default" }))).toHaveLength(1);
    expect(t.prompts).toEqual([]);

    expect(await t.run(t.passwords.reveal({ profileId: "default", id: 1 }))).toEqual({
      kind: "revealed",
      password: "correct-horse",
    });
    await t.run(t.passwords.reveal({ profileId: "default", id: 1 }));
    expect(await t.run(t.passwords.copy({ profileId: "default", id: 1 }))).toEqual({
      kind: "done",
    });
    expect(t.prompts).toEqual([
      { action: "reveal", site: "example.com" },
      { action: "reveal", site: "example.com" },
      { action: "copy", site: "example.com" },
    ]);
  });

  it("returns cancelled without the password when the check is declined", async () => {
    const t = setup({ approve: false });
    await t.addAlice();
    expect(await t.run(t.passwords.reveal({ profileId: "default", id: 1 }))).toEqual({
      kind: "cancelled",
    });
    expect(await t.run(t.passwords.copy({ profileId: "default", id: 1 }))).toEqual({
      kind: "cancelled",
    });
    expect(t.clipboard()).toBe("");
  });

  it("clears a copied password after 30 s only if the clipboard still holds it", async () => {
    const t = setup();
    await t.addAlice();
    await t.run(t.passwords.copy({ profileId: "default", id: 1 }));
    expect(t.clipboard()).toBe("correct-horse");
    expect(t.timers.map((timer) => timer.ms)).toEqual([30_000]);
    t.timers[0]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.clipboard()).toBe("");

    await t.run(t.passwords.copy({ profileId: "default", id: 1 }));
    t.setClipboard("something the user copied later");
    t.timers[1]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.clipboard()).toBe("something the user copied later");
  });

  it("normalizes the site, asks before http and duplicates, and updates on confirm", async () => {
    const t = setup();
    await t.addAlice();
    const insecure = {
      profileId: "default",
      url: "http://intranet.example/",
      username: "a",
      password: "p",
    };
    expect(await t.run(t.passwords.add(insecure))).toEqual({
      kind: "insecure",
      origin: "http://intranet.example",
    });
    expect(await t.run(t.passwords.add({ ...insecure, allowInsecure: true }))).toMatchObject({
      kind: "added",
    });
    // Loopback dev servers are fine over http.
    expect(
      await t.run(
        t.passwords.add({ ...insecure, url: "http://127.0.0.1:4000/login", username: "alice" }),
      ),
    ).toMatchObject({ kind: "added" });
    expect(await t.run(t.passwords.add({ ...insecure, url: "javascript:alert(1)" }))).toEqual({
      kind: "invalidUrl",
    });

    const duplicate = {
      profileId: "default",
      url: "example.com",
      username: "alice",
      password: "new-horse",
    };
    expect(await t.run(t.passwords.add(duplicate))).toEqual({ kind: "duplicate", id: 1 });
    expect(await t.run(t.passwords.add({ ...duplicate, replaceExisting: true }))).toEqual({
      kind: "updated",
      id: 1,
    });
    expect(await t.run(t.passwords.reveal({ profileId: "default", id: 1 }))).toMatchObject({
      password: "new-horse",
    });
    const logins = await t.run(t.passwords.list({ profileId: "default" }));
    expect(logins.map((login) => login.origin)).toEqual([
      "http://127.0.0.1:4000",
      "http://intranet.example",
      "https://example.com",
    ]);
  });

  it("reports a username clash on update and gates delete-all", async () => {
    const t = setup();
    await t.addAlice();
    await t.run(
      t.passwords.add({ profileId: "default", url: "example.com", username: "bob", password: "x" }),
    );
    expect(
      await t.run(t.passwords.update({ profileId: "default", id: 2, username: "alice" })),
    ).toEqual({ kind: "duplicate", id: 1 });

    t.setApprove(false);
    expect(await t.run(t.passwords.deleteAll("default"))).toEqual({ kind: "cancelled" });
    expect(await t.run(t.passwords.list({ profileId: "default" }))).toHaveLength(2);
    t.setApprove(true);
    expect(await t.run(t.passwords.deleteAll("default"))).toEqual({ kind: "deleted", count: 2 });
    expect(t.prompts.at(-1)).toEqual({ action: "deleteAll", site: undefined });
  });
});
