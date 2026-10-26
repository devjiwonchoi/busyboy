import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as BrowsingHistory from "./BrowsingHistory.ts";

const historyLayer = (baseDir: string) =>
  BrowsingHistory.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: baseDir,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
          ),
        ),
        NodeServices.layer,
      ),
    ),
  );

/** Just enough of a guest `WebContents` for the history listeners. */
const fakeGuest = ({ persistent }: { readonly persistent: boolean }) => {
  const emitter = new EventEmitter();
  let url = "about:blank";
  const guest = Object.assign(emitter, {
    session: { isPersistent: () => persistent },
    getURL: () => url,
  });
  return {
    guest: guest as unknown as WebContents,
    navigate: (next: string, code = 200) => {
      url = next;
      emitter.emit("did-navigate", {}, next, code);
    },
    navigateInPage: (next: string) => {
      url = next;
      emitter.emit("did-navigate-in-page", {}, next, true);
    },
    setTitle: (title: string) => emitter.emit("page-title-updated", {}, title),
  };
};

// Listeners record in forked fibers; give them a moment to land.
const settle = Effect.sleep("50 millis");

describe("historyUrl", () => {
  it("keeps web pages without fragments or credentials", () => {
    expect(BrowsingHistory.historyUrl("https://user:pw@example.com/a#section")).toBe(
      "https://example.com/a",
    );
    expect(BrowsingHistory.historyUrl("file:///etc/hosts")).toBeNull();
    expect(BrowsingHistory.historyUrl("not a url")).toBeNull();
  });
});

describe("mergeHistoryEntry", () => {
  it("keeps the larger counts and a real title, so re-importing does not double count", () => {
    const existing = {
      url: "https://a.test/",
      title: "https://a.test/",
      visitCount: 4,
      lastVisit: 10,
    };
    expect(
      BrowsingHistory.mergeHistoryEntry(existing, {
        ...existing,
        title: "A",
        visitCount: 2,
        lastVisit: 20,
      }),
    ).toEqual({ url: "https://a.test/", title: "A", visitCount: 4, lastVisit: 20 });
  });
});

describe("BrowsingHistory", () => {
  it.live("records visits and titles from persistent guests and finds them again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-history-" });

      yield* Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const tab = fakeGuest({ persistent: true });
        const privateTab = fakeGuest({ persistent: false });
        history.attachGuest(tab.guest);
        history.attachGuest(privateTab.guest);

        tab.navigate("https://github.com/devjiwonchoi/busyboy");
        yield* settle;
        tab.setTitle("busyboy");
        tab.navigateInPage("https://github.com/devjiwonchoi/busyboy#readme");
        tab.navigate("https://broken.test/", 500);
        privateTab.navigate("https://secret.test/");
        yield* settle;

        expect(yield* history.search({ text: "git", limit: 5 })).toEqual([
          expect.objectContaining({
            url: "https://github.com/devjiwonchoi/busyboy",
            title: "busyboy",
            visitCount: 1,
          }),
        ]);
        expect(yield* history.search({ text: "broken", limit: 5 })).toEqual([]);
        expect(yield* history.search({ text: "secret", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir)));

      // A new service instance reads what the previous one stored.
      yield* Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        expect((yield* history.search({ text: "busyboy", limit: 5 })).map((e) => e.url)).toEqual([
          "https://github.com/devjiwonchoi/busyboy",
        ]);
      }).pipe(Effect.provide(historyLayer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("imports recent entries and skips ones older than the history keeps", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-history-" });

      yield* Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const now = yield* Clock.currentTimeMillis;
        const result = yield* history.importEntries([
          { url: "https://recent.test/", title: "Recent", visitCount: 3, lastVisit: now },
          {
            url: "https://ancient.test/",
            title: "Ancient",
            visitCount: 9,
            lastVisit: now - 100 * 24 * 60 * 60 * 1000,
          },
        ]);
        expect(result).toEqual({ imported: 1 });
        expect((yield* history.search({ text: "test", limit: 5 })).map((e) => e.url)).toEqual([
          "https://recent.test/",
        ]);
      }).pipe(Effect.provide(historyLayer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("BrowsingHistory.clear", () => {
  it.effect("forgets every page and keeps the database private to the user", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-history-" });

      yield* Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const now = yield* Clock.currentTimeMillis;
        yield* history.importEntries([
          {
            url: "https://reset.example.com/?token=abc",
            title: "Reset",
            visitCount: 1,
            lastVisit: now,
          },
        ]);
        expect(yield* history.search({ text: "reset", limit: 5 })).toHaveLength(1);

        const info = yield* fileSystem.stat(`${environment.stateDir}/preview-history.sqlite`);
        expect(info.mode & 0o777).toBe(0o600);

        yield* history.clear;
        expect(yield* history.search({ text: "reset", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir)));

      // A fresh start reads the cleared database, not a stale copy.
      yield* Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        expect(yield* history.search({ text: "reset", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
