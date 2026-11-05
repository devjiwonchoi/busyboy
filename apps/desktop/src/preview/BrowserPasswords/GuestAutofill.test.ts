// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite vaults.
import type { BrowserPasswordAutofillEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { GuestAutofill, type AutofillFrame } from "./GuestAutofill.ts";
import { PasswordDatabase } from "./PasswordDatabase.ts";
import type { GuestLoginForm } from "./PasswordGuestMessages.ts";
import { makeTestCipher } from "./testCipher.ts";

const SITE = "http://127.0.0.1:4000";
const OTHER = "http://localhost:4001";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeFrame(key: number, origin: string, isMainFrame: boolean) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let currentOrigin = origin;
  const frame: AutofillFrame = {
    key,
    isMainFrame,
    origin: () => currentOrigin,
    isAlive: () => true,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  return {
    frame,
    sent,
    navigateTo: (next: string) => {
      currentOrigin = next;
    },
  };
}

const loginForm = (token: string, passwordFilled = false): GuestLoginForm => ({
  token,
  kind: "signIn",
  passwordFilled,
  fields: [
    { token: `${token}-u`, role: "username", rect: { x: 10, y: 20, width: 200, height: 24 } },
    {
      token: `${token}-p`,
      role: "currentPassword",
      rect: { x: 10, y: 60, width: 200, height: 24 },
    },
  ],
});

function setup(options: { approve?: boolean; offerToSave?: boolean } = {}) {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-autofill-"));
  const vault = PasswordDatabase.open(
    NodePath.join(directory, "passwords.sqlite"),
    makeTestCipher(),
  );
  cleanups.push(() => {
    vault.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  const events: BrowserPasswordAutofillEvent[] = [];
  const timers: Array<() => void> = [];
  let topLevelUrl = `${SITE}/login`;
  let agentActive = false;
  let nextId = 0;
  const authorizations: string[] = [];
  const autofill = new GuestAutofill({
    tabId: "tab-1",
    channels: { fill: "fill", dropdownState: "dropdown" },
    now: () => 1_000,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    randomId: () => `id-${++nextId}`,
    topLevelUrl: () => topLevelUrl,
    agentActiveWithin: () => agentActive,
    vault: () => vault,
    settings: () => ({ offerToSave: options.offerToSave ?? true }),
    authorizeFill: (site) => {
      authorizations.push(site);
      return Promise.resolve(options.approve ?? true);
    },
    emit: (event) => events.push(event),
    notifyChanged: () => {},
    rememberUsername: () => {},
    recallUsername: () => null,
  });
  return {
    autofill,
    vault,
    events,
    authorizations,
    setTopLevel: (url: string) => {
      topLevelUrl = url;
    },
    setAgentActive: (active: boolean) => {
      agentActive = active;
    },
    lastOf: <T extends BrowserPasswordAutofillEvent["type"]>(type: T) =>
      events.filter((event) => event.type === type).at(-1) as
        | Extract<BrowserPasswordAutofillEvent, { type: T }>
        | undefined,
    addAlice: (origin = SITE) =>
      vault.add({
        origin,
        username: "alice",
        password: "correct-horse",
        source: "saved",
        createdAt: 1,
      }),
  };
}

const focus = (formToken: string, field = "u") => ({
  formToken,
  fieldToken: `${formToken}-${field}`,
  rect: { x: 10, y: 20, width: 200, height: 24 },
});

describe("GuestAutofill fill", () => {
  it("lists saved logins for the frame's own origin and fills only that frame after the check", async () => {
    const t = setup();
    const id = t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.autofill.fieldFocused(main.frame, focus("f"));

    const list = t.lastOf("fillList")!;
    expect(list).toMatchObject({ rows: [{ loginId: id, username: "alice" }], frameOrigin: null });
    await t.autofill.choose(list.requestId, id);

    expect(t.authorizations).toEqual(["127.0.0.1:4000"]);
    expect(main.sent.filter((message) => message.channel === "fill")).toEqual([
      {
        channel: "fill",
        payload: { formToken: "f", username: "alice", password: "correct-horse" },
      },
    ]);
    expect(t.vault.get(id)?.lastFilledAt).toBe(1_000);
  });

  it("offers nothing when the frame's origin has no saved login (exact realm only)", () => {
    const t = setup();
    t.addAlice("https://127.0.0.1:4000");
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.autofill.fieldFocused(main.frame, focus("f"));
    expect(t.lastOf("fillList")).toBeUndefined();
  });

  it("scopes a cross-origin iframe to its own origin and labels it", async () => {
    const t = setup();
    t.setTopLevel(`${SITE}/iframe-host`);
    const id = t.addAlice(OTHER);
    const main = makeFrame(1, SITE, true);
    const child = makeFrame(2, OTHER, false);
    t.autofill.formsReported(main.frame, { forms: [] });
    t.autofill.frameTokenReported(child.frame, { token: "child" });
    t.autofill.childFrameReported(main.frame, {
      childToken: "child",
      rect: { x: 100, y: 200, width: 400, height: 300 },
    });
    t.autofill.formsReported(child.frame, { forms: [loginForm("c")] });
    t.autofill.fieldFocused(child.frame, focus("c"));

    const list = t.lastOf("fillList")!;
    expect(list.frameOrigin).toBe(OTHER);
    expect(list.rect).toEqual({ x: 110, y: 220, width: 200, height: 24 });
    await t.autofill.choose(list.requestId, id);
    expect(child.sent.some((message) => message.channel === "fill")).toBe(true);
    expect(main.sent.some((message) => message.channel === "fill")).toBe(false);
  });

  it("refuses to fill when the frame left the login's origin while the check was up", async () => {
    const t = setup();
    const id = t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.autofill.fieldFocused(main.frame, focus("f"));
    const list = t.lastOf("fillList")!;
    main.navigateTo("https://evil.example");
    await t.autofill.choose(list.requestId, id);
    expect(main.sent.some((message) => message.channel === "fill")).toBe(false);
  });

  it("fills nothing when the device check is declined", async () => {
    const t = setup({ approve: false });
    const id = t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.autofill.fieldFocused(main.frame, focus("f"));
    await t.autofill.choose(t.lastOf("fillList")!.requestId, id);
    expect(main.sent.some((message) => message.channel === "fill")).toBe(false);
  });

  it("never opens the list for agent focus, and ignores opaque origins", () => {
    const t = setup();
    t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.setAgentActive(true);
    t.autofill.fieldFocused(main.frame, focus("f"));
    expect(t.lastOf("fillList")).toBeUndefined();

    t.setAgentActive(false);
    const sandboxed = makeFrame(3, "null", false);
    t.autofill.formsReported(sandboxed.frame, { forms: [loginForm("s")] });
    t.autofill.fieldFocused(sandboxed.frame, focus("s"));
    expect(t.lastOf("fillList")).toBeUndefined();
  });

  it("moves the selection with forwarded keys and fills on Enter", async () => {
    const t = setup();
    const id = t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f")] });
    t.autofill.fieldFocused(main.frame, focus("f"));
    t.autofill.fieldKey(main.frame, { formToken: "f", fieldToken: "f-u", key: "ArrowDown" });
    expect(t.lastOf("fillList")?.selectedIndex).toBe(0);
    t.autofill.fieldKey(main.frame, { formToken: "f", fieldToken: "f-u", key: "Enter" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(main.sent.some((message) => message.channel === "fill")).toBe(true);
    expect(t.vault.get(id)?.lastFilledAt).toBe(1_000);
  });
});

describe("GuestAutofill save", () => {
  const signIn = (password: string, username = "alice") => ({
    formToken: "f",
    kind: "signIn" as const,
    username,
    password,
  });

  it("offers to save after a successful sign-in, and saves on confirm", () => {
    const t = setup();
    const main = makeFrame(1, SITE, true);
    t.autofill.formsReported(main.frame, { forms: [loginForm("f", true)] });
    t.autofill.submitted(main.frame, signIn("correct-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);

    const prompt = t.lastOf("savePrompt")!;
    expect(prompt).toMatchObject({
      mode: "save",
      origin: SITE,
      username: "alice",
      collapsed: false,
    });
    expect(JSON.stringify(t.events)).not.toContain("correct-horse");
    expect(t.autofill.peek(prompt.promptId)).toBe("correct-horse");

    t.autofill.respondToPrompt(prompt.promptId, "save", "alice");
    const [saved] = t.vault.list();
    expect(saved).toMatchObject({ origin: SITE, username: "alice", source: "saved", timesUsed: 1 });
    expect(t.vault.revealPassword(saved!.id)).toBe("correct-horse");
    expect(t.autofill.peek(prompt.promptId)).toBeNull();
  });

  it("does not prompt after a failed sign-in", () => {
    const t = setup();
    const main = makeFrame(1, SITE, true);
    t.autofill.submitted(main.frame, signIn("wrong"));
    t.autofill.topLevelCommitted(`${SITE}/login`);
    t.autofill.formsReported(main.frame, { forms: [loginForm("g", false)] });
    expect(t.lastOf("savePrompt")).toBeUndefined();
  });

  it("offers an update for a changed password and stays silent for the same one", () => {
    const t = setup();
    const id = t.addAlice();
    const main = makeFrame(1, SITE, true);
    t.autofill.submitted(main.frame, signIn("correct-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);
    expect(t.lastOf("savePrompt")).toBeUndefined();
    expect(t.vault.get(id)?.timesUsed).toBe(1);

    t.setTopLevel(`${SITE}/login`);
    t.autofill.submitted(main.frame, signIn("new-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);
    const prompt = t.lastOf("savePrompt")!;
    expect(prompt.mode).toBe("update");
    t.autofill.respondToPrompt(prompt.promptId, "save", undefined);
    expect(t.vault.revealPassword(id)).toBe("new-horse");
  });

  it("remembers 'Never for this site'", () => {
    const t = setup();
    const main = makeFrame(1, SITE, true);
    t.autofill.submitted(main.frame, signIn("correct-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);
    t.autofill.respondToPrompt(t.lastOf("savePrompt")!.promptId, "never", undefined);
    expect(t.vault.isNeverSave(SITE)).toBe(true);

    const before = t.events.length;
    t.setTopLevel(`${SITE}/login`);
    t.autofill.submitted(main.frame, signIn("correct-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);
    expect(t.events.slice(before).some((event) => event.type === "savePrompt")).toBe(false);
  });

  it("never prompts for agent submissions or when saving is turned off", () => {
    const agent = setup();
    const main = makeFrame(1, SITE, true);
    agent.setAgentActive(true);
    agent.autofill.submitted(main.frame, signIn("correct-horse"));
    agent.autofill.topLevelCommitted(`${SITE}/welcome`);
    expect(agent.lastOf("savePrompt")).toBeUndefined();

    const off = setup({ offerToSave: false });
    off.autofill.submitted(main.frame, signIn("correct-horse"));
    off.autofill.topLevelCommitted(`${SITE}/welcome`);
    expect(off.lastOf("savePrompt")).toBeUndefined();
  });

  it("keys an iframe login to the iframe's origin and says so", () => {
    const t = setup();
    t.setTopLevel(`${SITE}/iframe-host`);
    const child = makeFrame(2, OTHER, false);
    t.autofill.formsReported(child.frame, { forms: [loginForm("c", true)] });
    t.autofill.submitted(child.frame, { ...signIn("correct-horse"), formToken: "c" });
    t.autofill.frameNavigated(2);
    t.autofill.formsReported(child.frame, { forms: [] });
    expect(t.lastOf("savePrompt")).toMatchObject({ origin: OTHER, frameOrigin: OTHER });
  });

  it("folds the prompt into the key icon after leaving the origin, and reopens it", () => {
    const t = setup();
    const main = makeFrame(1, SITE, true);
    t.autofill.submitted(main.frame, signIn("correct-horse"));
    t.autofill.topLevelCommitted(`${SITE}/welcome`);
    t.autofill.topLevelCommitted("https://news.example/");
    expect(t.lastOf("savePrompt")?.collapsed).toBe(true);
    t.autofill.reopenPrompt();
    expect(t.lastOf("savePrompt")?.collapsed).toBe(false);
    t.autofill.dispose();
    expect(t.lastOf("savePromptClosed")).toBeDefined();
  });
});
