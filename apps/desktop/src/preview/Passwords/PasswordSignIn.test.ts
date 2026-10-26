import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
 * check as told, and can navigate away while the user is deciding.
 */
const fakePage = ({
  origin,
  fieldsValid,
}: {
  readonly origin: string;
  readonly fieldsValid: boolean;
}) => {
  const log: Array<string> = [];
  const frame = { origin, isDestroyed: () => false };
  const guest = {
    mainFrame: frame,
    session: { isPersistent: () => true },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: [{ code: string }]) => {
      if (code.includes("checkFields")) {
        log.push("check");
        return { password: fieldsValid, username: true, submit: true };
      }
      log.push(code.includes("hunter2") ? "fill hunter2" : "fill other");
      return true;
    },
  };
  return {
    log,
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
          approve: ({ accounts }) => Effect.sync(() => approve(accounts)),
        }),
      ),
    ),
  );

describe("PasswordSignIn", () => {
  it.effect("fills only after approval, locks first, and returns no secret", () =>
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
          guest: page.guest,
          request,
          lock: (secret) => page.log.push(`lock ${secret}`),
        }),
      );

      expect(result).toEqual({ status: "submitted" });
      expect(offered).toEqual([["octo", "alt"]]);
      expect(page.log).toEqual(["check", "lock hunter2", "fill hunter2"]);
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
          guest: page.guest,
          request: { ...request, account: "alt" },
          lock: () => {},
        }),
      );

      expect(offered).toEqual([["alt"]]);
      expect(page.log).toContain("fill other");
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
          yield* Effect.promise(() => declining.signIn({ guest: noLogin.guest, request, lock })),
        ).toEqual({ status: "unavailable" });

        const badFields = fakePage({ origin: "https://github.com", fieldsValid: false });
        expect(
          yield* Effect.promise(() => declining.signIn({ guest: badFields.guest, request, lock })),
        ).toEqual({ status: "locator_invalid" });

        const declined = fakePage({ origin: "https://github.com", fieldsValid: true });
        expect(
          yield* Effect.promise(() => declining.signIn({ guest: declined.guest, request, lock })),
        ).toEqual({ status: "declined" });

        expect(
          yield* Effect.promise(() =>
            declining.signIn({ guest: declined.guest, request: { passwordSelector: "" }, lock }),
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
        service.signIn({ guest: page.guest, request, lock: (secret) => lockAttempts.push(secret) }),
      );

      expect(result).toEqual({ status: "origin_changed" });
      expect(lockAttempts).toEqual([]);
    }),
  );
});
