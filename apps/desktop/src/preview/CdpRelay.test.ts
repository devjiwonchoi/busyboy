import { describe, expect, it, vi } from "vite-plus/test";

import {
  CREDENTIAL_LOCKED_MESSAGE,
  createCdpRelayConnection,
  type CdpRelayTarget,
} from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
  credentials: Pick<CdpRelayTarget, "signIn" | "credentialLocked" | "noteAgentScript"> = {
    signIn: async () => ({ status: "unavailable" }),
    credentialLocked: () => false,
    noteAgentScript: () => {},
  },
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
  ...credentials,
});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "t3-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session");
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "t3-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const relay = createCdpRelayConnection(makeTarget(send), () => {});
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "t3-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await settle();
    expect(send.mock.calls).toEqual([["Runtime.runIfWaitingForDebugger", {}, "iframe-session"]]);
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    // Electron passes an empty session id for the page's own events.
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "t3-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["t3-preview-page", extra]);
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "t3-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });

  it("answers sign-in itself and never forwards it to the page", async () => {
    const send = vi.fn(async () => ({}));
    const signIn = vi.fn(async () => ({ status: "submitted" }));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, () => {}, {
        signIn,
        credentialLocked: () => false,
        noteAgentScript: () => {},
      }),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Busyboy.signIn",
        params: { passwordSelector: "#pw" },
        sessionId: "t3-preview-page",
      }),
    );
    await settle();
    expect(signIn).toHaveBeenCalledWith({ passwordSelector: "#pw" });
    expect(send).not.toHaveBeenCalled();
    expect(written).toEqual([
      { id: 1, result: { status: "submitted" }, sessionId: "t3-preview-page" },
    ]);
  });

  it("refuses page reads but allows leaving while a saved password is in the page", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, () => {}, {
        signIn: async () => ({}),
        credentialLocked: () => true,
        noteAgentScript: () => {},
      }),
      (raw) => written.push(JSON.parse(raw)),
    );
    for (const [id, method] of [
      [1, "Runtime.evaluate"],
      [2, "Runtime.callFunctionOn"],
      [3, "DOM.getDocument"],
      [4, "Input.dispatchMouseEvent"],
      [5, "Page.captureScreenshot"],
      [6, "Page.navigate"],
    ] as const) {
      relay.receive(JSON.stringify({ id, method, sessionId: "t3-preview-page" }));
    }
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Page.navigate", {}, undefined);
    expect(
      written.filter((message) => message["error"] !== undefined).map((message) => message["id"]),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(written[0]).toEqual({
      id: 1,
      error: { code: -32000, message: CREDENTIAL_LOCKED_MESSAGE },
      sessionId: "t3-preview-page",
    });
  });

  it("treats script the agent runs in the page as agent script, and refuses it while locked", async () => {
    const send = vi.fn(async () => ({}));
    let locked = false;
    const noteAgentScript = vi.fn();
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, () => {}, {
        signIn: async () => ({}),
        credentialLocked: () => locked,
        noteAgentScript,
      }),
      (raw) => written.push(JSON.parse(raw)),
    );
    const page = (id: number, method: string, params: Record<string, unknown>) =>
      relay.receive(JSON.stringify({ id, method, params, sessionId: "t3-preview-page" }));

    page(1, "Busyboy.noteAgentScript", {});
    page(2, "Page.navigate", { url: " JavaScript:alert(1)" });
    page(3, "Page.reload", { scriptToEvaluateOnLoad: "steal()" });
    page(4, "Page.navigate", { url: "https://example.com/" });
    await settle();
    expect(noteAgentScript).toHaveBeenCalledTimes(3);

    locked = true;
    page(5, "Page.navigate", { url: "javascript:void 0" });
    page(6, "Page.reload", { scriptToEvaluateOnLoad: "steal()" });
    page(7, "Page.reload", {});
    await settle();
    expect(
      written.filter((message) => message["error"] !== undefined).map((message) => message["id"]),
    ).toEqual([5, 6]);
    expect(send).toHaveBeenLastCalledWith("Page.reload", {}, undefined);
  });
});
