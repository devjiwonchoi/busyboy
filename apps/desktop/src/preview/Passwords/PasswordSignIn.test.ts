import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { WebContents } from "electron";

import * as PasswordSignIn from "./PasswordSignIn.ts";
import * as PasswordVault from "./PasswordVault.ts";

const saved = [
  {
    origin: "https://github.com",
    username: "octo",
    password: "hunter2",
    source: "chrome" as const,
    savedAt: 2,
  },
  {
    origin: "https://github.com",
    username: "alt",
    password: "other",
    source: "chrome" as const,
    savedAt: 1,
  },
];

const request = {
  usernameSelector: "#login",
  passwordSelector: "#password",
  submitSelector: "button[type=submit]",
};

/**
 * A page that records the scripts the sign-in world runs, answers the field
 * check as told, and can navigate away while the user is deciding. Its
 * sign-in request carries the stand-in unless `sendsStandIn` is false, as
 * when a page hashes the password before sending it.
 */
const fakePage = ({
  origin,
  fieldsValid,
  sendsStandIn = true,
}: {
  readonly origin: string;
  readonly fieldsValid: boolean;
  readonly sendsStandIn?: boolean;
}) => {
  const log: Array<string> = [];
  const scripts: Array<string> = [];
  const swaps: Array<{ readonly password: string; readonly standIn: string }> = [];
  let cancelled = false;
  const substitute: PasswordSignIn.SubstitutePassword = ({ standIn, password }) => {
    swaps.push({ standIn, password });
    return {
      ready: Promise.resolve(),
      done: sendsStandIn ? Promise.resolve(true) : new Promise<boolean>(() => {}),
      cancel: () => {
        cancelled = true;
      },
    };
  };
  const frame = { origin, isDestroyed: () => false };
  const guest = {
    id: 1,
    on: () => {},
    off: () => {},
    once: () => {},
    mainFrame: frame,
    session: {
      isPersistent: () => true,
      webRequest: { onBeforeRequest: () => {} },
    },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: [{ code: string }]) => {
      scripts.push(code);
      if (code.includes("checkFields")) {
        log.push("check");
        return { password: fieldsValid, username: true, submit: true };
      }
      if (code.includes("clearPasswordFields")) {
        log.push("clear");
        return undefined;
      }
      const standIn = swaps.at(-1)?.standIn;
      log.push(standIn !== undefined && code.includes(standIn) ? "fill stand-in" : "fill ?");
      return true;
    },
  };
  return {
    log,
    scripts,
    swaps,
    substitute,
    cancelled: () => cancelled,
    guest: guest as unknown as WebContents,
    navigateAway: () => {
      guest.mainFrame = { origin: "https://evil.test", isDestroyed: () => false };
    },
  };
};

const signInWith = ({
  approve,
}: {
  readonly approve: (accounts: ReadonlyArray<string>) => string | null;
}) =>
  PasswordSignIn.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(PasswordVault.PasswordVault)({
          loginsFor: (origin) => Effect.succeed(saved.filter((entry) => entry.origin === origin)),
          save: () => Effect.die("unused"),
          setChromeSync: () => Effect.die("unused"),
          attachGuest: () => () => {},
        }),
        Layer.succeed(PasswordSignIn.PasswordSignInApproval, {
          approve: ({ accounts }) =>
            Effect.sync(() => {
              const account = approve(accounts);
              return account === null ? "declined" : { account };
            }),
        }),
      ),
    ),
  );

describe("PasswordSignIn", () => {
  it.effect("puts only a stand-in in the page, after approval and the lock", () =>
    Effect.gen(function* () {
      const offered: Array<ReadonlyArray<string>> = [];
      const service = yield* signInWith({
        approve: (accounts) => {
          offered.push(accounts);
          return "octo";
        },
      });
      const page = fakePage({ origin: "https://github.com", fieldsValid: true });

      const result = yield* Effect.promise(() =>
        service.signIn({
          substitute: page.substitute,
          pageModified: false,
          guest: page.guest,
          request,
          lock: (secret) => page.log.push(`lock ${secret}`),
        }),
      );

      expect(result).toEqual({ status: "submitted" });
      expect(offered).toEqual([["octo", "alt"]]);
      expect(page.log).toEqual(["check", "lock hunter2", "fill stand-in"]);
      expect(page.swaps).toHaveLength(1);
      expect(page.swaps[0]!.password).toBe("hunter2");
      expect(page.swaps[0]!.standIn).not.toContain("hunter2");
      expect(page.scripts.some((code) => code.includes("hunter2"))).toBe(false);
    }),
  );

  it.effect("offers only the account the agent names", () =>
    Effect.gen(function* () {
      const offered: Array<ReadonlyArray<string>> = [];
      const service = yield* signInWith({
        approve: (accounts) => {
          offered.push(accounts);
          return accounts[0] ?? null;
        },
      });
      const page = fakePage({ origin: "https://github.com", fieldsValid: true });

      yield* Effect.promise(() =>
        service.signIn({
          substitute: page.substitute,
          pageModified: false,
          guest: page.guest,
          request: { ...request, account: "alt" },
          lock: () => {},
        }),
      );

      expect(offered).toEqual([["alt"]]);
      expect(page.swaps.map((swap) => swap.password)).toEqual(["other"]);
    }),
  );

  it.effect(
    "never fills when there is nothing to fill, the fields are wrong, or the user says no",
    () =>
      Effect.gen(function* () {
        const declining = yield* signInWith({ approve: () => null });
        const lockAttempts: Array<string> = [];
        const lock = (secret: string) => lockAttempts.push(secret);

        const noLogin = fakePage({ origin: "https://example.com", fieldsValid: true });
        expect(
          yield* Effect.promise(() =>
            declining.signIn({
              substitute: noLogin.substitute,
              pageModified: false,
              guest: noLogin.guest,
              request,
              lock,
            }),
          ),
        ).toEqual({ status: "unavailable" });

        const badFields = fakePage({ origin: "https://github.com", fieldsValid: false });
        expect(
          yield* Effect.promise(() =>
            declining.signIn({
              substitute: badFields.substitute,
              pageModified: false,
              guest: badFields.guest,
              request,
              lock,
            }),
          ),
        ).toEqual({ status: "locator_invalid" });

        const declined = fakePage({ origin: "https://github.com", fieldsValid: true });
        expect(
          yield* Effect.promise(() =>
            declining.signIn({
              substitute: declined.substitute,
              pageModified: false,
              guest: declined.guest,
              request,
              lock,
            }),
          ),
        ).toEqual({ status: "declined" });

        expect(
          yield* Effect.promise(() =>
            declining.signIn({
              substitute: declined.substitute,
              pageModified: false,
              guest: declined.guest,
              request: { passwordSelector: "" },
              lock,
            }),
          ),
        ).toEqual({ status: "locator_invalid" });

        expect(lockAttempts).toEqual([]);
      }),
  );

  it.effect("drops the sign-in when the page leaves the site during approval", () =>
    Effect.gen(function* () {
      const page = fakePage({ origin: "https://github.com", fieldsValid: true });
      const service = yield* signInWith({
        approve: () => {
          page.navigateAway();
          return "octo";
        },
      });
      const lockAttempts: Array<string> = [];

      const result = yield* Effect.promise(() =>
        service.signIn({
          substitute: page.substitute,
          pageModified: false,
          guest: page.guest,
          request,
          lock: (secret) => lockAttempts.push(secret),
        }),
      );

      expect(result).toEqual({ status: "origin_changed" });
      expect(lockAttempts).toEqual([]);
    }),
  );

  it.effect("does not ask again for a while after the user declines", () =>
    Effect.gen(function* () {
      let prompts = 0;
      const service = yield* signInWith({
        approve: () => {
          prompts += 1;
          return null;
        },
      });
      const page = fakePage({ origin: "https://github.com", fieldsValid: true });

      for (const _attempt of [1, 2, 3]) {
        expect(
          yield* Effect.promise(() =>
            service.signIn({
              substitute: page.substitute,
              pageModified: false,
              guest: page.guest,
              request,
              lock: () => {},
            }),
          ),
        ).toEqual({ status: "declined" });
      }
      expect(prompts).toBe(1);
    }),
  );

  it.effect("refuses a page the agent already ran its own script in", () =>
    Effect.gen(function* () {
      let prompts = 0;
      const service = yield* signInWith({
        approve: () => {
          prompts += 1;
          return "octo";
        },
      });
      const page = fakePage({ origin: "https://github.com", fieldsValid: true });

      expect(
        yield* Effect.promise(() =>
          service.signIn({
            substitute: page.substitute,
            guest: page.guest,
            request,
            pageModified: true,
            lock: () => {},
          }),
        ),
      ).toEqual({ status: "page_modified" });
      expect(prompts).toBe(0);
      expect(page.log).toEqual([]);
    }),
  );

  it.effect("reports a page whose sign-in request never carries the stand-in", () =>
    Effect.gen(function* () {
      const service = yield* signInWith({ approve: () => "octo" });
      const page = fakePage({
        origin: "https://github.com",
        fieldsValid: true,
        sendsStandIn: false,
      });

      const signingIn = yield* Effect.promise(() =>
        service.signIn({
          substitute: page.substitute,
          pageModified: false,
          guest: page.guest,
          request,
          lock: () => {},
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("16 seconds");

      expect(yield* Fiber.join(signingIn)).toEqual({ status: "unsupported" });
      expect(page.cancelled()).toBe(true);
      expect(page.log).toEqual(["check", "fill stand-in", "clear"]);
    }),
  );
});
