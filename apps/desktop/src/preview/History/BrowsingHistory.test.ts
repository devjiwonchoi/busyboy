import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as BrowsingHistory from "./BrowsingHistory.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const environmentLayer = (baseDir: string) =>
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
  );

const historyLayer = (baseDir: string) =>
  BrowsingHistory.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environmentLayer(baseDir), NodeServices.layer)),
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
    navigate: (next: string, { code = 200, byPage = false } = {}) => {
      emitter.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        initiator: byPage ? {} : null,
      });
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

const entry = (url: string, lastVisit: number, extra: { visitCount?: number } = {}) => ({
  url,
  title: url,
  visitCount: extra.visitCount ?? 1,
  lastVisit,
  typed: false,
});

/** Listeners record in forked fibers, so checks retry until they hold. */
const eventually = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  check.pipe(Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }));

const expectSearch = (
  history: BrowsingHistory.BrowsingHistory["Service"],
  text: string,
  expected: ReadonlyArray<unknown>,
) =>
  history
    .search({ text, limit: 20 })
    .pipe(Effect.flatMap((found) => Effect.try(() => expect(found).toEqual(expected))));

const urlsFor = (history: BrowsingHistory.BrowsingHistory["Service"], text: string) =>
  history.search({ text, limit: 20 }).pipe(Effect.map((found) => found.map((e) => e.url)));

const withTempHome = <A, E, R>(use: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* use(yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-history-" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("historyUrl", () => {
  it("keeps web pages without fragments or credentials", () => {
    expect(BrowsingHistory.historyUrl("https://user:pw@example.com/a#section")).toBe(
      "https://example.com/a",
    );
    expect(BrowsingHistory.historyUrl("file:///etc/hosts")).toBeNull();
    expect(BrowsingHistory.historyUrl("not a url")).toBeNull();
  });

  it("drops query parameters that look like secrets and keeps the rest", () => {
    expect(
      BrowsingHistory.historyUrl(
        "https://app.test/reset?token=abc&page=2&X-Amz-Signature=s&api_key=k&code=c&q=shoes",
      ),
    ).toBe("https://app.test/reset?page=2&q=shoes");
    expect(
      BrowsingHistory.historyUrl("https://a.test/?access_token=1&sessionId=2&sig=3&otp=4"),
    ).toBe("https://a.test/");
  });
});

describe("cleanTitle", () => {
  it("removes bidi and control characters that could disguise a page", () => {
    expect(BrowsingHistory.cleanTitle("Bank\u202e moc.live\u202c \n login")).toBe(
      "Bank moc.live login",
    );
  });
});

describe("mergeHistoryEntry", () => {
  it("keeps the larger counts, a real title and the typed mark, so re-importing does not double count", () => {
    const existing = { ...entry("https://a.test/", 10, { visitCount: 4 }), typed: true };
    expect(
      BrowsingHistory.mergeHistoryEntry(existing, {
        ...existing,
        title: "A",
        visitCount: 2,
        lastVisit: 20,
        typed: false,
      }),
    ).toEqual({ url: "https://a.test/", title: "A", visitCount: 4, lastVisit: 20, typed: true });
  });
});

describe("BrowsingHistory", () => {
  it.live("records visits and titles from persistent guests and finds them again", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const history = yield* BrowsingHistory.BrowsingHistory;
          const tab = fakeGuest({ persistent: true });
          const privateTab = fakeGuest({ persistent: false });
          history.attachGuest(tab.guest);
          history.attachGuest(privateTab.guest);

          tab.navigate("https://github.com/devjiwonchoi/busyboy");
          yield* eventually(
            urlsFor(history, "git").pipe(Effect.filterOrFail((urls) => urls.length === 1)),
          );
          tab.setTitle("busyboy");
          tab.navigateInPage("https://github.com/devjiwonchoi/busyboy#readme");
          tab.navigate("https://broken.test/", { code: 500 });
          privateTab.navigate("https://secret.test/");

          yield* eventually(
            expectSearch(history, "git", [
              expect.objectContaining({
                url: "https://github.com/devjiwonchoi/busyboy",
                title: "busyboy",
                visitCount: 1,
              }),
            ]),
          );
          expect(yield* history.search({ text: "broken", limit: 5 })).toEqual([]);
          expect(yield* history.search({ text: "secret", limit: 5 })).toEqual([]);
        }).pipe(Effect.provide(historyLayer(baseDir)));

        // A new service instance reads what the previous one stored.
        yield* Effect.gen(function* () {
          const history = yield* BrowsingHistory.BrowsingHistory;
          expect(yield* urlsFor(history, "busyboy")).toEqual([
            "https://github.com/devjiwonchoi/busyboy",
          ]);
        }).pipe(Effect.provide(historyLayer(baseDir)));
      }),
    ),
  );

  it.live("marks only address-bar pages as typed and does not count reloads", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const tab = fakeGuest({ persistent: true });
        history.attachGuest(tab.guest);

        history.markTyped(tab.guest);
        tab.navigate("https://github.com/");
        tab.navigate("https://github.com/");
        tab.navigate("https://github.com/");
        // A page's own link lands after the typed one, so it is not typed.
        history.markTyped(tab.guest);
        tab.navigate("https://github.com.evil.io/", { byPage: true });

        yield* eventually(
          expectSearch(history, "github", [
            expect.objectContaining({ url: "https://github.com/", typed: true, visitCount: 1 }),
            expect.objectContaining({ url: "https://github.com.evil.io/", typed: false }),
          ]),
        );
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("does not record pages the agent navigates to", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const tab = fakeGuest({ persistent: true });
        let agentDriving = true;
        history.attachGuest(tab.guest, { isAgentDriving: () => agentDriving });

        tab.navigate("https://agent.test/opened");
        tab.navigateInPage("https://agent.test/opened/step-2");
        agentDriving = false;
        tab.navigate("https://user.test/");

        yield* eventually(expectSearch(history, "user", [expect.anything()]));
        expect(yield* history.search({ text: "agent", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("strips secret parameters from recorded and imported pages", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const now = yield* Clock.currentTimeMillis;
        const tab = fakeGuest({ persistent: true });
        history.attachGuest(tab.guest);

        tab.navigate("https://visited.test/login?session=s3cret&next=home");
        yield* history.importEntries([
          entry("https://imported.test/reset?reset_token=t0ken&lang=en", now),
        ]);

        yield* eventually(
          urlsFor(history, "test").pipe(
            Effect.flatMap((urls) =>
              Effect.try(() =>
                expect(urls.toSorted()).toEqual([
                  "https://imported.test/reset?lang=en",
                  "https://visited.test/login?next=home",
                ]),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("imports recent entries and skips ones older than the history keeps", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const now = yield* Clock.currentTimeMillis;
        const result = yield* history.importEntries([
          { ...entry("https://recent.test/", now, { visitCount: 3 }), title: "Recent" },
          entry("https://ancient.test/", now - 100 * DAY_MS),
        ]);
        expect(result).toEqual({ imported: 1 });
        expect(yield* urlsFor(history, "test")).toEqual(["https://recent.test/"]);

        // Importing again counts only pages it had not seen.
        expect(
          yield* history.importEntries([
            entry("https://recent.test/", now),
            entry("https://new.test/", now),
          ]),
        ).toEqual({ imported: 1 });
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("keeps at most the cap, dropping the lowest-ranked pages", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const now = yield* Clock.currentTimeMillis;
        yield* history.importEntries([
          entry("https://favourite.test/", now - 30 * DAY_MS, { visitCount: 500 }),
        ]);
        yield* history.importEntries(
          Array.from({ length: BrowsingHistory.HISTORY_MAX_ENTRIES }, (_, index) =>
            entry(`https://page-${index}.test/`, now - index * 1000),
          ),
        );

        const all = yield* history.search({ text: "test", limit: 20 });
        expect(all[0]?.url).toBe("https://favourite.test/");
        // The newest of the bulk pages survive; the oldest went.
        expect(yield* urlsFor(history, "page-0.test")).toEqual(["https://page-0.test/"]);
        expect(
          yield* urlsFor(history, `page-${BrowsingHistory.HISTORY_MAX_ENTRIES - 1}.test`),
        ).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("closes the connection when reading the history fails", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
          Effect.provide(environmentLayer(baseDir)),
        );
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        // A row that does not decode makes every load fail after the open.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`create table places (url text primary key, title text not null,
            visit_count integer not null, last_visit integer not null,
            typed integer not null default 0)`;
          yield* sql`insert into places values ('https://a.test/', 'A', 1, 1, 'not a number')`;
        }).pipe(
          Effect.provide(
            NodeSqliteClient.layer({
              filename: `${environment.stateDir}/preview-history.sqlite`,
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const history = yield* BrowsingHistory.BrowsingHistory;
          const openFiles = fileSystem
            .readDirectory("/dev/fd")
            .pipe(Effect.map((fds) => fds.length));
          yield* Effect.flip(history.search({ text: "a", limit: 5 }));
          const before = yield* openFiles;
          for (let attempt = 0; attempt < 5; attempt++) {
            expect((yield* Effect.flip(history.search({ text: "a", limit: 5 }))).operation).toBe(
              "read",
            );
          }
          expect(yield* openFiles).toBeLessThanOrEqual(before);
        }).pipe(Effect.provide(historyLayer(baseDir)));
      }),
    ),
  );

  it.live("retries opening the database after a failed open", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const history = yield* BrowsingHistory.BrowsingHistory;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const filename = `${environment.stateDir}/preview-history.sqlite`;
        // A directory where the file should be makes the open fail.
        yield* fileSystem.makeDirectory(filename, { recursive: true });
        expect((yield* Effect.flip(history.search({ text: "a", limit: 5 }))).operation).toBe(
          "open",
        );

        yield* fileSystem.remove(filename, { recursive: true });
        expect(yield* history.search({ text: "a", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );
});

describe("BrowsingHistory.clear", () => {
  it.live("forgets every page, on disk too, and keeps the database private to the user", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const secretPage = "https://reset.example.com/account/very-private-page";

        yield* Effect.gen(function* () {
          const history = yield* BrowsingHistory.BrowsingHistory;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const filename = `${environment.stateDir}/preview-history.sqlite`;
          const now = yield* Clock.currentTimeMillis;
          yield* history.importEntries([
            { ...entry(secretPage, now), title: "Private reset page" },
          ]);
          expect(yield* history.search({ text: "reset", limit: 5 })).toHaveLength(1);

          const info = yield* fileSystem.stat(filename);
          expect(info.mode & 0o777).toBe(0o600);

          yield* history.clear;
          expect(yield* history.search({ text: "reset", limit: 5 })).toEqual([]);
          const bytes = new TextDecoder("latin1").decode(yield* fileSystem.readFile(filename));
          expect(bytes).not.toContain("very-private-page");
          expect(bytes).not.toContain("Private reset page");
        }).pipe(Effect.provide(historyLayer(baseDir)));

        // A fresh start reads the cleared database, not a stale copy.
        yield* Effect.gen(function* () {
          const history = yield* BrowsingHistory.BrowsingHistory;
          expect(yield* history.search({ text: "reset", limit: 5 })).toEqual([]);
        }).pipe(Effect.provide(historyLayer(baseDir)));
      }),
    ),
  );

  it.live("drops an import that started before the clear", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const history = yield* BrowsingHistory.BrowsingHistory;
        const now = yield* Clock.currentTimeMillis;
        const generation = yield* history.generation;

        yield* history.clear;
        const result = yield* history.importEntries([entry("https://late.test/", now)], {
          generation,
        });

        expect(result).toEqual({ imported: 0 });
        expect(yield* history.search({ text: "late", limit: 5 })).toEqual([]);
      }).pipe(Effect.provide(historyLayer(baseDir))),
    ),
  );

  it.live("removes copies of Chrome's history left by an interrupted import", () =>
    withTempHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
          Effect.provide(environmentLayer(baseDir)),
        );
        const copy = `${environment.stateDir}/preview-history-import/t3code-history-import-x`;
        yield* fileSystem.makeDirectory(copy, { recursive: true });
        yield* fileSystem.writeFileString(`${copy}/History`, "copy");

        yield* Effect.gen(function* () {
          yield* BrowsingHistory.BrowsingHistory;
          expect(yield* fileSystem.exists(copy)).toBe(false);
        }).pipe(Effect.provide(historyLayer(baseDir)));
      }),
    ),
  );
});
