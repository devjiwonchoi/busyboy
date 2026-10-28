// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Buffer } from "node:buffer";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PasswordSignIn from "./Passwords/PasswordSignIn.ts";

// These tests do not sign in; the relay only needs the service to exist.
const makeHost = DesktopBrowserHost.make.pipe(Effect.provide(PasswordSignIn.layerTest));

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const cleared: Array<{ readonly origin?: string; readonly storages?: Array<string> }> = [];
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isDestroyed: () => false,
    session: {
      clearStorageData: async (options: (typeof cleared)[number]) => {
        cleared.push(options);
      },
    },
  });
  return {
    cleared,
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      host.attach(key, makeDebuggee().tab);

      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      // Commands first wait for the page's password check.
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;

      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );

  it.effect(
    "keeps the agent off the page while it signs in and while the page shows the password",
    () =>
      Effect.gen(function* () {
        const secret = 'hunter2 "pw"';
        let finishSignIn: () => void = () => {};
        let pageShowsPassword = true;
        const host = yield* DesktopBrowserHost.make.pipe(
          Effect.provideService(PasswordSignIn.PasswordSignIn, {
            signIn: async ({ lock, substitute }) => {
              lock(secret);
              substitute({
                standIn: "Qq7standin0000000",
                password: secret,
                pageOrigin: "https://example.com",
              });
              // Resolves once the swap is over, as the real sign-in does.
              await new Promise<void>((resolve) => {
                finishSignIn = resolve;
              });
              return { status: "submitted" };
            },
            pageHoldsPassword: async () => false,
            // The server echoed the submitted password into the page.
            pageContainsSecret: async () => pageShowsPassword,
            clearPasswordFields: async () => {},
          }),
        );
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        const collected = yield* takeEvents(host, 8).pipe(Effect.forkChild);
        const agent = (message: Record<string, unknown>) =>
          host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));
        const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        const page = debuggee.tab.webContents as unknown as NodeEvents.EventEmitter;

        // Let the collector subscribe before the agent starts talking.
        yield* settle;
        yield* agent({ id: 1, method: "Target.setAutoAttach", params: {} });
        yield* agent({
          id: 2,
          method: "Busyboy.signIn",
          params: { passwordSelector: "#pw" },
          sessionId: "t3-preview-page",
        });
        yield* settle;
        // The swap is still armed: the agent could read the stand-in and have
        // the page send it somewhere that echoes the password back.
        yield* agent({ id: 3, method: "DOM.getDocument", sessionId: "t3-preview-page" });
        debuggee.emit("Network.requestWillBeSent", {
          request: {
            postData: `password=${encodeURIComponent(secret)}`,
            json: { password: secret },
            postDataEntries: [
              { bytes: Buffer.from(`{"user":"octo","password":"${secret}"}`).toString("base64") },
            ],
          },
        });
        yield* settle;

        finishSignIn();
        yield* settle;
        yield* agent({ id: 4, method: "DOM.getDocument", sessionId: "t3-preview-page" });
        yield* settle;

        // The next page does not show it, so the agent is let back in.
        pageShowsPassword = false;
        page.emit("did-navigate");
        page.emit("dom-ready");
        yield* settle;
        yield* agent({ id: 5, method: "DOM.getDocument", sessionId: "t3-preview-page" });
        yield* settle;
        debuggee.release();
        yield* settle;

        const messages = (yield* Fiber.join(collected)).flatMap((event) =>
          event.type === "cdp" ? [event.message] : [],
        );
        const replies = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
        expect(replies.find((reply) => reply["id"] === 2)).toEqual({
          id: 2,
          result: { status: "submitted" },
          sessionId: "t3-preview-page",
        });
        for (const id of [3, 4]) {
          expect(replies.find((reply) => reply["id"] === id)).toMatchObject({
            error: { message: expect.stringContaining("saved password") },
          });
        }
        expect(replies.find((reply) => reply["id"] === 5)).toMatchObject({
          result: { method: "DOM.getDocument" },
        });
        const network = messages.find((message) => message.includes("requestWillBeSent"))!;
        expect(network).not.toContain("hunter2");
        expect(network).not.toContain(
          Buffer.from('"password":"hunter2').toString("base64").slice(0, 12),
        );
        expect(network.match(/\[saved password\]/g)).toHaveLength(3);
      }),
  );

  it.effect("holds an attaching agent's commands until the page is checked, then runs them", () =>
    Effect.gen(function* () {
      let finishCheck: (holdsPassword: boolean) => void = () => {};
      const host = yield* DesktopBrowserHost.make.pipe(
        Effect.provideService(PasswordSignIn.PasswordSignIn, {
          signIn: async () => ({ status: "unavailable" }),
          pageHoldsPassword: () =>
            new Promise<boolean>((resolve) => {
              finishCheck = resolve;
            }),
          pageContainsSecret: async () => false,
          clearPasswordFields: async () => {},
        }),
      );
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const collected = yield* takeEvents(host, 4).pipe(Effect.forkChild);
      const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const agent = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* settle;
      yield* agent({ id: 1, method: "Target.setAutoAttach", params: {} });
      // Playwright's page setup, which is not allowed while locked.
      yield* agent({
        id: 2,
        method: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: "" },
        sessionId: "t3-preview-page",
      });
      yield* settle;
      finishCheck(false);
      yield* settle;
      debuggee.release();

      const replies = (yield* Fiber.join(collected)).flatMap((event) =>
        event.type === "cdp" ? [JSON.parse(event.message) as Record<string, unknown>] : [],
      );
      expect(replies.find((reply) => reply["id"] === 2)).toMatchObject({
        result: { method: "Page.addScriptToEvaluateOnNewDocument" },
      });
    }),
  );

  it.effect("starts an agent that attaches after a person's autofill locked out", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.lockForFilledPassword(debuggee.tab.webContents, "s3cret");
      host.attach(key, debuggee.tab);
      const collected = yield* takeEvents(host, 4).pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const agent = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* agent({ id: 1, method: "Target.setAutoAttach", params: {} });
      yield* agent({ id: 2, method: "DOM.getDocument", sessionId: "t3-preview-page" });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      debuggee.release();

      const replies = (yield* Fiber.join(collected)).flatMap((event) =>
        event.type === "cdp" ? [JSON.parse(event.message) as Record<string, unknown>] : [],
      );
      expect(replies.find((reply) => reply["id"] === 2)).toMatchObject({
        error: { message: expect.stringContaining("saved password") },
      });
    }),
  );

  it.effect("keeps the agent off a password a person's autofill put in its page", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      const pageEvents = new NodeEvents.EventEmitter();
      Object.assign(debuggee.tab.webContents, {
        on: pageEvents.on.bind(pageEvents),
        off: pageEvents.off.bind(pageEvents),
        isDestroyed: () => false,
      });
      host.attach(key, debuggee.tab);
      const collected = yield* takeEvents(host, 3).pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const agent = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      expect(host.isAgentDriving(debuggee.tab.webContents)).toBe(false);
      yield* agent({ id: 1, method: "Input.dispatchMouseEvent", sessionId: "t3-preview-page" });
      // The agent's own click must not get the page an autofill.
      expect(host.isAgentDriving(debuggee.tab.webContents)).toBe(true);

      host.lockForFilledPassword(debuggee.tab.webContents, "s3cret");
      yield* agent({ id: 2, method: "Runtime.evaluate", sessionId: "t3-preview-page" });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      pageEvents.emit("did-navigate");
      debuggee.release();

      const replies = (yield* Fiber.join(collected)).flatMap((event) =>
        event.type === "cdp" ? [JSON.parse(event.message) as Record<string, unknown>] : [],
      );
      expect(replies.find((reply) => reply["id"] === 2)).toMatchObject({
        error: { message: expect.stringContaining("saved password") },
      });
    }),
  );

  it.effect("never autofills a site again after the agent ran its own script there", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const page = debuggee.tab.webContents as unknown as NodeEvents.EventEmitter;
      const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const agent = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* settle;
      yield* agent({ id: 1, method: "Busyboy.noteAgentScript", sessionId: "t3-preview-page" });
      yield* settle;
      expect(host.isAgentDriving(debuggee.tab.webContents)).toBe(true);

      // A new document on the same site: script the agent left in a popup or
      // a service worker could still be there.
      page.emit("did-navigate");
      const otherTab = makeDebuggee();
      expect(host.isAgentDriving(debuggee.tab.webContents)).toBe(true);
      expect(host.isAgentDriving(otherTab.tab.webContents)).toBe(true);
    }),
  );

  it.effect("wipes service workers and caches on every site the agent drove the tab through", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const page = debuggee.tab.webContents as unknown as NodeEvents.EventEmitter;
      const wiped = () =>
        debuggee.cleared.map(({ origin, storages }) => `${origin} ${storages?.join("+")}`);

      // The agent loads a login page with a third-party frame on it.
      page.emit("did-frame-navigate", {}, "https://login.example.com/session", 200, "OK", true);
      page.emit("did-frame-navigate", {}, "https://widgets.example.net/frame", 200, "OK", false);
      page.emit("did-frame-navigate", {}, "about:blank", 200, "OK", false);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));

      expect(wiped()).toEqual([
        "http://localhost serviceworkers+cachestorage",
        "https://login.example.com serviceworkers+cachestorage",
        "https://widgets.example.net serviceworkers+cachestorage",
      ]);

      // Closing the tab wipes the site it was left on too.
      host.detach(key);
      expect(wiped().slice(3)).toEqual(["http://localhost serviceworkers+cachestorage"]);
    }),
  );
});
