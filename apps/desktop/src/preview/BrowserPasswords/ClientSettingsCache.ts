import type { ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Client settings live in a file, so reading them is asynchronous. Guest
 * messages need an answer right away, so they use the last value read, which
 * is refreshed in the background (at start and whenever a page reports its
 * login forms). Callers that can wait use `read` for the current value.
 */
export interface ClientSettingsCache {
  readonly current: () => ClientSettings | null;
  readonly refresh: () => void;
  readonly read: () => Promise<ClientSettings | null>;
}

export function makeClientSettingsCache<E>(input: {
  readonly get: Effect.Effect<Option.Option<ClientSettings>, E>;
  readonly runFork: (effect: Effect.Effect<void>) => void;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}): ClientSettingsCache {
  let cached: ClientSettings | null = null;
  const load = input.get.pipe(
    Effect.map(Option.getOrNull),
    Effect.tap((settings) =>
      Effect.sync(() => {
        cached = settings;
      }),
    ),
  );
  return {
    current: () => cached,
    refresh: () => input.runFork(load.pipe(Effect.asVoid, Effect.ignore)),
    read: () => input.runPromise(load.pipe(Effect.orElseSucceed(() => cached))),
  };
}
