import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeClientSettingsCache } from "./ClientSettingsCache.ts";

describe("ClientSettingsCache", () => {
  it("answers synchronously while the settings file is read asynchronously", async () => {
    let stored = { ...DEFAULT_CLIENT_SETTINGS, browserOfferToSavePasswords: false };
    // Like the real service: the read only completes after a turn of the event loop.
    const get = Effect.sleep("1 millis").pipe(Effect.map(() => Option.some(stored)));
    const pending: Array<Promise<unknown>> = [];
    const cache = makeClientSettingsCache({
      get,
      runFork: (effect) => {
        pending.push(Effect.runPromise(effect));
      },
      runPromise: Effect.runPromise,
    });

    expect(cache.current()).toBeNull();
    cache.refresh();
    expect(cache.current()).toBeNull();
    await Promise.all(pending);
    expect(cache.current()?.browserOfferToSavePasswords).toBe(false);

    stored = { ...stored, browserOfferToSavePasswords: true };
    expect((await cache.read())?.browserOfferToSavePasswords).toBe(true);
    expect(cache.current()?.browserOfferToSavePasswords).toBe(true);
  });

  it("keeps the last value when a read fails", async () => {
    let fail = false;
    const cache = makeClientSettingsCache({
      get: Effect.suspend(() =>
        fail ? Effect.fail("unreadable") : Effect.succeedSome(DEFAULT_CLIENT_SETTINGS),
      ),
      runFork: (effect) => {
        Effect.runFork(effect);
      },
      runPromise: Effect.runPromise,
    });
    expect(await cache.read()).toEqual(DEFAULT_CLIENT_SETTINGS);
    fail = true;
    expect(await cache.read()).toEqual(DEFAULT_CLIENT_SETTINGS);
  });
});
