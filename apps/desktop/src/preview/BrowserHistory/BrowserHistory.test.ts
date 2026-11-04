// @effect-diagnostics nodeBuiltinImport:off - Tests use temp-dir node:sqlite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { makeBrowserHistory, profileDirectoryName } from "./BrowserHistory.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 4, 12);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { deletionLocked?: boolean; rootIsFile?: boolean } = {}) {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-history-service-"));
  const rootDirectory = NodePath.join(directory, "BrowserProfiles");
  if (options.rootIsFile) NodeFs.writeFileSync(rootDirectory, "not a directory");
  let now = NOW;
  const errors: string[] = [];
  const changes: string[] = [];
  const history = makeBrowserHistory({
    rootDirectory,
    deletionLocked: options.deletionLocked ?? false,
    now: () => now,
    // Writes run synchronously so assertions need no waiting.
    schedule: (task) => task(),
    onError: (message) => errors.push(message),
  });
  history.subscribeChanges((profileId) => changes.push(profileId));
  cleanups.push(() => {
    history.close();
    NodeFs.rmSync(directory, { recursive: true, force: true });
  });
  const visitWith = (session: object, url: string, agent: { threadId: string } | null = null) => {
    const recorder = history.recorderFor(session, { agentAttribution: () => agent });
    if (recorder === null) return false;
    recorder.startNavigation({ url, isMainFrame: true, isSameDocument: false });
    recorder.commit({ url, httpResponseCode: 200 });
    recorder.stopLoading();
    return true;
  };
  const urls = (profileId: string) =>
    Effect.runSync(history.search({ profileId, limit: 50 })).visits.map((visit) => visit.url);
  return {
    history,
    rootDirectory,
    errors,
    changes,
    visitWith,
    urls,
    setNow: (next: number) => {
      now = next;
    },
  };
}

describe("BrowserHistory", () => {
  it("records persistent profiles and never records incognito or unknown sessions", () => {
    const t = setup();
    const persistent = {};
    const incognito = {};
    t.history.registerSession(persistent, { profileId: "default", persistent: true });
    t.history.registerSession(incognito, { profileId: "incognito", persistent: false });

    expect(t.visitWith(persistent, "https://a.test/")).toBe(true);
    expect(t.visitWith(incognito, "https://secret.test/")).toBe(false);
    expect(t.visitWith({}, "https://unknown.test/")).toBe(false);

    expect(t.urls("default")).toEqual(["https://a.test/"]);
    expect(
      NodeFs.existsSync(NodePath.join(t.rootDirectory, profileDirectoryName("incognito"))),
    ).toBe(false);
    expect(t.changes).toEqual(["default"]);
  });

  it("recognises a guest's session by its storage path, not object identity", () => {
    const t = setup();
    t.history.registerSession(
      { storagePath: "/tmp/Partitions/t3code-preview-a" },
      { profileId: "default", persistent: true },
    );
    expect(
      t.visitWith({ storagePath: "/tmp/Partitions/t3code-preview-a" }, "https://a.test/"),
    ).toBe(true);
    expect(t.visitWith({ storagePath: "/tmp/Partitions/other" }, "https://b.test/")).toBe(false);
    expect(t.urls("default")).toEqual(["https://a.test/"]);
  });

  it("keeps each profile's history separate and tags agent visits", () => {
    const t = setup();
    const work = {};
    const personal = {};
    t.history.registerSession(work, { profileId: "work", persistent: true });
    t.history.registerSession(personal, { profileId: "personal", persistent: true });
    t.visitWith(work, "http://127.0.0.1:3000/welcome", { threadId: "thread-1" });
    t.visitWith(personal, "https://news.test/");

    expect(t.urls("work")).toEqual(["http://127.0.0.1:3000/welcome"]);
    expect(t.urls("personal")).toEqual(["https://news.test/"]);
    const agentVisits = Effect.runSync(
      t.history.search({ profileId: "work", source: "agent", limit: 10 }),
    ).visits;
    expect(agentVisits).toEqual([
      expect.objectContaining({ source: "agent", transition: "agent", threadId: "thread-1" }),
    ]);
  });

  it("clears history by time range, and all time removes the database files", () => {
    const t = setup();
    const session = {};
    t.history.registerSession(session, { profileId: "default", persistent: true });
    t.setNow(NOW - 2 * DAY);
    t.visitWith(session, "https://two-days.test/");
    t.setNow(NOW - 2 * HOUR);
    t.visitWith(session, "https://two-hours.test/");
    t.setNow(NOW - 10 * 60 * 1000);
    t.visitWith(session, "https://ten-minutes.test/");
    t.setNow(NOW);

    Effect.runSync(t.history.clearHistory({ profileId: "default", range: "hour" }));
    expect(t.urls("default")).toEqual(["https://two-hours.test/", "https://two-days.test/"]);
    Effect.runSync(t.history.clearHistory({ profileId: "default", range: "day" }));
    expect(t.urls("default")).toEqual(["https://two-days.test/"]);

    const directory = NodePath.join(t.rootDirectory, profileDirectoryName("default"));
    expect(NodeFs.existsSync(directory)).toBe(true);
    Effect.runSync(t.history.clearHistory({ profileId: "default", range: "all" }));
    expect(NodeFs.existsSync(directory)).toBe(false);
    expect(t.urls("default")).toEqual([]);

    // Recording resumes into a fresh database.
    t.visitWith(session, "https://after.test/");
    expect(t.urls("default")).toEqual(["https://after.test/"]);
  });

  it("removes entries by visit and by URL", () => {
    const t = setup();
    const session = {};
    t.history.registerSession(session, { profileId: "default", persistent: true });
    t.visitWith(session, "https://a.test/");
    t.visitWith(session, "https://b.test/");
    const [latest] = Effect.runSync(t.history.search({ profileId: "default", limit: 10 })).visits;

    Effect.runSync(t.history.remove({ profileId: "default", visitIds: [latest!.id] }));
    expect(t.urls("default")).toEqual(["https://a.test/"]);
    Effect.runSync(t.history.remove({ profileId: "default", urls: ["https://a.test/"] }));
    expect(t.urls("default")).toEqual([]);
  });

  it("rejects remove and clear when deletion is locked", () => {
    const t = setup({ deletionLocked: true });
    const session = {};
    t.history.registerSession(session, { profileId: "default", persistent: true });
    t.visitWith(session, "https://a.test/");

    const removed = Effect.runSync(
      Effect.flip(t.history.remove({ profileId: "default", urls: ["https://a.test/"] })),
    );
    expect(removed._tag).toBe("BrowserHistoryDeletionLockedError");
    const cleared = Effect.runSync(
      Effect.flip(t.history.clearHistory({ profileId: "default", range: "all" })),
    );
    expect(cleared._tag).toBe("BrowserHistoryDeletionLockedError");
    expect(t.urls("default")).toEqual(["https://a.test/"]);
    expect(Effect.runSync(t.history.status("default")).deletionLocked).toBe(true);
  });

  it("imports legacy history into the default profile once and prunes stale entries", () => {
    const t = setup();
    const entries = [
      { url: "https://a.test/", lastVisitedAt: NOW - DAY, title: "A" },
      { url: "https://b.test/", lastVisitedAt: NOW - 2 * DAY },
      { url: "https://ancient.test/", lastVisitedAt: NOW - 91 * DAY },
    ];

    expect(Effect.runSync(t.history.importLegacy(entries))).toEqual({ imported: 2 });
    expect(Effect.runSync(t.history.importLegacy(entries))).toEqual({ imported: 0 });
    expect(t.urls("default")).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("prunes visits older than 90 days when a profile opens", () => {
    const t = setup();
    const session = {};
    t.history.registerSession(session, { profileId: "default", persistent: true });
    t.setNow(NOW - 91 * DAY);
    t.visitWith(session, "https://stale.test/");
    t.history.close();
    t.setNow(NOW);
    expect(t.urls("default")).toEqual([]);
  });

  it("keeps browsing when the database cannot be opened, and reports it once", () => {
    const t = setup({ rootIsFile: true });
    const session = {};
    t.history.registerSession(session, { profileId: "default", persistent: true });

    expect(() => t.visitWith(session, "https://a.test/")).not.toThrow();
    t.visitWith(session, "https://b.test/");
    expect(Effect.runSync(t.history.status("default"))).toEqual({
      available: false,
      deletionLocked: false,
    });
    const failure = Effect.runSync(
      Effect.flip(t.history.search({ profileId: "default", limit: 10 })),
    );
    expect(failure._tag).toBe("BrowserHistoryUnavailableError");
    expect(t.errors).toHaveLength(1);
  });
});
