import { describe, expect, it } from "@effect/vitest";
import { ADDRESS_BAR_SEARCH_ENGINES } from "@t3tools/shared/preview";

import {
  mayRequestRemoteSuggestions,
  parseOpenSearchSuggestions,
  RemoteSuggestionClient,
} from "./RemoteSearchSuggestions.ts";

const engine = ADDRESS_BAR_SEARCH_ENGINES.duckduckgo;

/** Manual clock: timers run only when `advance` passes them. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout: (callback: () => void, ms: number) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance: async (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await Promise.resolve();
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function client(respond: (url: string, signal: AbortSignal) => Promise<string>) {
  const timers = fakeTimers();
  const calls: string[] = [];
  const instance = new RemoteSuggestionClient({
    fetch: (url, signal) => {
      calls.push(url);
      return respond(url, signal);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { instance, calls, timers };
}

const gate = (input: string, overrides: { enabled?: boolean; incognito?: boolean } = {}) => ({
  enabled: true,
  incognito: false,
  engine,
  input,
  ...overrides,
});

describe("RemoteSuggestionClient", () => {
  it("sends nothing while the setting is off, across a whole typing sequence", async () => {
    const { instance, calls, timers } = client(() => Promise.resolve('["x",["y"]]'));
    const typed = "localhost:";
    const results = [];
    for (let index = 1; index <= typed.length; index += 1) {
      results.push(instance.request(gate(typed.slice(0, index), { enabled: false })));
      await timers.advance(40);
    }
    await timers.advance(5_000);
    expect(await Promise.all(results)).toEqual(results.map(() => []));
    expect(calls).toEqual([]);
  });

  it("never sends for incognito, credentials, empty input, or engines without an endpoint", async () => {
    const { instance, calls, timers } = client(() => Promise.resolve('["x",["y"]]'));
    const pending = [
      instance.request(gate("weather", { incognito: true })),
      instance.request(gate("alice:secret@example.com")),
      instance.request(gate("https://alice:secret@example.com/")),
      instance.request(gate("   ")),
      instance.request({
        ...gate("weather"),
        engine: { ...engine, id: "custom", suggestUrl: null },
      }),
    ];
    await timers.advance(5_000);
    expect(await Promise.all(pending)).toEqual([[], [], [], [], []]);
    expect(calls).toEqual([]);
  });

  it("debounces typing and only fetches the latest text", async () => {
    const { instance, calls, timers } = client((url) =>
      Promise.resolve(
        JSON.stringify(["q", [decodeURIComponent(url.split("q=")[1]!.split("&")[0]!)]]),
      ),
    );
    const first = instance.request(gate("wea"));
    await timers.advance(100);
    const second = instance.request(gate("weat"));
    await timers.advance(100);
    const third = instance.request(gate("weather"));
    await timers.advance(150);

    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(await third).toEqual(["weather"]);
    expect(calls).toEqual(["https://duckduckgo.com/ac/?q=weather&type=list"]);
  });

  it("aborts an in-flight request when new input arrives, and times out after 1.5 s", async () => {
    const signals: AbortSignal[] = [];
    const { instance, calls, timers } = client(
      (_url, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const first = instance.request(gate("rust"));
    await timers.advance(150);
    expect(calls).toHaveLength(1);
    const second = instance.request(gate("rust lang"));
    expect(signals[0]?.aborted).toBe(true);
    expect(await first).toEqual([]);

    await timers.advance(150);
    expect(calls).toHaveLength(2);
    await timers.advance(1_500);
    expect(signals[1]?.aborted).toBe(true);
    expect(await second).toEqual([]);
  });
});

describe("turning suggestions off", () => {
  it("drops a request still waiting out its debounce", async () => {
    const { instance, calls, timers } = client(() => Promise.resolve('["x",["y"]]'));
    let enabled = true;
    const pending = instance.request({ ...gate("weather"), stillEnabled: () => enabled });
    await timers.advance(100);
    enabled = false;
    await timers.advance(100);
    expect(await pending).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("remote suggestion helpers", () => {
  it("reads at most four distinct OpenSearch suggestions", () => {
    expect(parseOpenSearchSuggestions('["q",["a","b","a"," ","c","d","e"]]')).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(parseOpenSearchSuggestions("<html>")).toEqual([]);
    expect(parseOpenSearchSuggestions('{"q":1}')).toEqual([]);
  });

  it("allows plain search text when enabled", () => {
    expect(mayRequestRemoteSuggestions(gate("how to center a div"))).toBe(true);
  });
});
