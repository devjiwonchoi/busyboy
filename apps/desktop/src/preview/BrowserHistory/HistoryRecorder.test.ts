import { describe, expect, it } from "@effect/vitest";

import type { NewVisit } from "./HistoryDatabase.ts";
import {
  HistoryRecorder,
  NAVIGATION_HINT_TTL_MS,
  type AgentAttribution,
} from "./HistoryRecorder.ts";

function harness() {
  let now = 1_000;
  let agent: AgentAttribution | null = null;
  const visits: NewVisit[] = [];
  const titles: Array<[string, string]> = [];
  const recorder = new HistoryRecorder({
    now: () => now,
    agentAttribution: () => agent,
    record: (visit) => visits.push(visit),
    setTitle: (url, title) => titles.push([url, title]),
  });
  const load = (url: string, httpResponseCode = 200) => {
    recorder.startNavigation({ url, isMainFrame: true, isSameDocument: false });
    recorder.commit({ url, httpResponseCode });
    recorder.stopLoading();
  };
  return {
    recorder,
    visits,
    titles,
    load,
    advance: (ms: number) => {
      now += ms;
    },
    setAgent: (next: AgentAttribution | null) => {
      agent = next;
    },
  };
}

describe("HistoryRecorder", () => {
  it("records a committed main-frame load once it stops loading, with its title", () => {
    const h = harness();
    h.recorder.startNavigation({
      url: "https://a.test/",
      isMainFrame: true,
      isSameDocument: false,
    });
    h.recorder.commit({ url: "https://a.test/", httpResponseCode: 200 });
    h.recorder.title("A");
    expect(h.visits).toEqual([]);
    h.recorder.stopLoading();
    expect(h.visits).toEqual([
      {
        url: "https://a.test/",
        title: "A",
        visitedAt: 1_000,
        transition: "link",
        source: "user",
        threadId: null,
      },
    ]);
    h.recorder.title("A, later");
    expect(h.titles).toEqual([["https://a.test/", "A, later"]]);
  });

  it("skips subframes, fragment-only changes and non-web URLs", () => {
    const h = harness();
    h.load("https://a.test/page");
    h.recorder.startNavigation({
      url: "https://ads.test/",
      isMainFrame: false,
      isSameDocument: false,
    });
    h.recorder.inPageNavigation({ url: "https://ads.test/x", isMainFrame: false });
    h.recorder.inPageNavigation({ url: "https://a.test/page#section", isMainFrame: true });
    h.load("about:blank");
    h.load("data:text/html,hi");
    expect(h.visits.map((visit) => visit.url)).toEqual(["https://a.test/page"]);
  });

  it("records pushState changes as link visits", () => {
    const h = harness();
    h.load("https://app.test/");
    h.recorder.inPageNavigation({ url: "https://app.test/settings", isMainFrame: true });
    expect(h.visits.map((visit) => [visit.url, visit.transition])).toEqual([
      ["https://app.test/", "link"],
      ["https://app.test/settings", "link"],
    ]);
  });

  it("drops error pages and failed loads", () => {
    const h = harness();
    h.load("https://missing.test/", 404);
    h.load("https://broken.test/", 500);

    h.recorder.startNavigation({
      url: "https://down.test/",
      isMainFrame: true,
      isSameDocument: false,
    });
    h.recorder.failLoad({ url: "https://down.test/", isMainFrame: true });
    h.recorder.commit({ url: "https://down.test/", httpResponseCode: 0 });
    h.recorder.stopLoading();

    h.recorder.startNavigation({
      url: "https://late.test/",
      isMainFrame: true,
      isSameDocument: false,
    });
    h.recorder.commit({ url: "https://late.test/", httpResponseCode: 200 });
    h.recorder.failLoad({ url: "https://late.test/", isMainFrame: true });
    h.recorder.stopLoading();

    expect(h.visits).toEqual([]);
  });

  it("uses BusyBoy's own hints for typed, reload and back/forward navigations", () => {
    const h = harness();
    h.recorder.setHint("typed");
    h.load("https://a.test/");
    h.recorder.setHint("reload");
    h.load("https://a.test/");
    h.recorder.setHint("back_forward");
    h.load("https://b.test/");
    h.load("https://c.test/");
    expect(h.visits.map((visit) => visit.transition)).toEqual([
      "typed",
      "reload",
      "back_forward",
      "link",
    ]);
  });

  it("ignores a stale hint", () => {
    const h = harness();
    h.recorder.setHint("typed");
    h.advance(NAVIGATION_HINT_TTL_MS + 1);
    h.load("https://a.test/");
    expect(h.visits[0]?.transition).toBe("link");
  });

  it("tags navigations an agent caused with the agent source and thread", () => {
    const h = harness();
    h.setAgent({ threadId: "thread-7" });
    h.load("http://127.0.0.1:4000/welcome");
    h.setAgent(null);
    h.load("http://127.0.0.1:4000/after");
    expect(h.visits.map((visit) => [visit.source, visit.transition, visit.threadId])).toEqual([
      ["agent", "agent", "thread-7"],
      ["user", "link", null],
    ]);
  });

  it("prefers a user hint over a recent agent command", () => {
    const h = harness();
    h.setAgent({ threadId: "thread-7" });
    h.recorder.setHint("typed");
    h.load("https://a.test/");
    expect(h.visits[0]).toMatchObject({ source: "user", transition: "typed" });
  });

  it("tags only the first load of a tab an agent opened, even when it started before the recorder", () => {
    const h = harness();
    h.recorder.openedByAgent("thread-9");
    // The guest began loading on its own, so the recorder sees only the commit.
    h.recorder.commit({ url: "http://127.0.0.1:4000/login", httpResponseCode: 200 });
    h.recorder.stopLoading();
    h.load("http://127.0.0.1:4000/next");
    expect(h.visits.map((visit) => [visit.source, visit.transition, visit.threadId])).toEqual([
      ["agent", "agent", "thread-9"],
      ["user", "link", null],
    ]);
  });

  it("records the pending visit when the next navigation starts or the guest goes away", () => {
    const h = harness();
    h.recorder.startNavigation({
      url: "https://a.test/",
      isMainFrame: true,
      isSameDocument: false,
    });
    h.recorder.commit({ url: "https://a.test/", httpResponseCode: 200 });
    h.recorder.startNavigation({
      url: "https://b.test/",
      isMainFrame: true,
      isSameDocument: false,
    });
    h.recorder.commit({ url: "https://b.test/", httpResponseCode: 200 });
    h.recorder.dispose();
    h.recorder.commit({ url: "https://c.test/", httpResponseCode: 200 });
    h.recorder.dispose();
    expect(h.visits.map((visit) => visit.url)).toEqual(["https://a.test/", "https://b.test/"]);
  });
});
