import { PreviewAutomationSignInInput, type PreviewSignInResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import { guardPasswordSubmission } from "./CredentialNetworkGuard.ts";
import { isFillableOrigin } from "./PasswordEntry.ts";
import {
  checkFields,
  clearPasswordFieldsScript,
  fillAndSubmit,
  pageContainsSecretScript,
  pageHoldsPasswordScript,
} from "./PasswordSignInScripts.ts";
import { makeStandIn, type Substitution } from "./PasswordSubstitution.ts";
import * as PasswordVault from "./PasswordVault.ts";

/**
 * Scripts run in their own world: the page cannot wrap the setters or DOM
 * methods they use, so it learns the values only the way a typed login would.
 */
const SIGN_IN_WORLD_ID = 1_009;

/**
 * After the user declines, the same tab and site are not asked again for a
 * while, so an agent cannot keep re-prompting until someone taps through.
 */
const DECLINE_COOLDOWN_MS = 2 * 60_000;

/** How long the sign-in request may take to leave after the form is submitted. */
const SUBSTITUTION_WAIT = "15 seconds";

export type SubstitutePassword = (input: {
  readonly standIn: string;
  readonly password: string;
  readonly pageOrigin: string;
}) => Substitution;

const SignInRequest = PreviewAutomationSignInInput.mapFields(
  ({ tabId: _tabId, ...fields }) => fields,
);
type SignInRequest = typeof SignInRequest.Type;
const decodeSignInRequest = Schema.decodeUnknownOption(SignInRequest);

const runInSignInWorld = <A>(
  guest: Electron.WebContents,
  script: (argument: never) => A,
  argument: unknown,
): Promise<A> =>
  guest.executeJavaScriptInIsolatedWorld(SIGN_IN_WORLD_ID, [
    { code: `(${script.toString()})(${JSON.stringify(argument)})` },
  ]);

/** The account the user approved, or why there is none. */
export type SignInApproval =
  | { readonly account: string }
  | "declined"
  /** No biometric check is available, so an agent sign-in cannot be approved safely. */
  | "unavailable";

export class PasswordSignInApproval extends Context.Service<
  PasswordSignInApproval,
  {
    readonly approve: (input: {
      readonly guest: Electron.WebContents;
      readonly site: string;
      readonly accounts: ReadonlyArray<string>;
    }) => Effect.Effect<SignInApproval>;
  }
>()("@t3tools/desktop/preview/Passwords/PasswordSignIn/PasswordSignInApproval") {}

const accountLabel = (username: string) => (username === "" ? "the saved login" : username);

/**
 * Lets the user pick an account, then requires Touch ID. Without Touch ID an
 * agent cannot sign in: a plain dialog could be clicked by anything that can
 * drive the screen, including a computer-use agent.
 */
export const layerApproval = Layer.effect(
  PasswordSignInApproval,
  Effect.gen(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;

    const ask = (owner: Electron.BrowserWindow | undefined, options: Electron.MessageBoxOptions) =>
      dialog.showMessageBox(options, owner).pipe(
        Effect.map((result) => Option.some(result.response)),
        Effect.orElseSucceed(() => Option.none<number>()),
      );

    return PasswordSignInApproval.of({
      approve: Effect.fn("PasswordSignInApproval.approve")(function* ({
        guest,
        site,
        accounts,
      }): Effect.fn.Return<SignInApproval> {
        if (!Electron.systemPreferences.canPromptTouchID?.()) {
          return "unavailable";
        }
        const host = guest.hostWebContents;
        const owner =
          host && !host.isDestroyed()
            ? (Electron.BrowserWindow.fromWebContents(host) ?? undefined)
            : undefined;

        let account = accounts[0];
        if (accounts.length > 1) {
          const choice = yield* ask(owner, {
            type: "question",
            message: `An agent wants to sign in to ${site}`,
            detail: "Choose the saved login it may use. The agent never sees the password.",
            buttons: [...accounts.map(accountLabel), "Cancel"],
            cancelId: accounts.length,
            defaultId: accounts.length,
          });
          account = Option.isSome(choice) ? accounts[choice.value] : undefined;
        }
        if (account === undefined) {
          return "declined";
        }

        const reason = `let an agent sign in to ${site} as ${accountLabel(account)}`;
        const approved = yield* Effect.tryPromise(() =>
          Electron.systemPreferences.promptTouchID(reason),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return approved ? { account } : "declined";
      }),
    });
  }),
);

export class PasswordSignIn extends Context.Service<
  PasswordSignIn,
  {
    /**
     * Signs the guest's page in with a saved login the user approves. `lock`
     * runs just before the password enters the page, so the caller can stop
     * the agent from reading it. The result never carries the login.
     */
    readonly signIn: (input: {
      readonly guest: Electron.WebContents;
      readonly request: unknown;
      /** The agent already ran its own JavaScript in this page. */
      readonly pageModified: boolean;
      readonly lock: (secret: string) => void;
      /** Swaps the real password into the sign-in request in place of `standIn`. */
      readonly substitute: SubstitutePassword;
    }) => Promise<PreviewSignInResult>;
    readonly pageHoldsPassword: (guest: Electron.WebContents) => Promise<boolean>;
    /** True when the page shows `secret`; a page that cannot be checked counts as showing it. */
    readonly pageContainsSecret: (guest: Electron.WebContents, secret: string) => Promise<boolean>;
    readonly clearPasswordFields: (guest: Electron.WebContents) => Promise<void>;
  }
>()("@t3tools/desktop/preview/Passwords/PasswordSignIn") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vault = yield* PasswordVault.PasswordVault;
  const approval = yield* PasswordSignInApproval;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const declinedUntil = new Map<string, number>();

  const signInEffect = Effect.fn("PasswordSignIn.signIn")(function* ({
    guest,
    request,
    pageModified,
    lock,
    substitute,
  }: {
    readonly guest: Electron.WebContents;
    readonly request: SignInRequest;
    readonly pageModified: boolean;
    readonly lock: (secret: string) => void;
    readonly substitute: SubstitutePassword;
  }) {
    // Script the agent left in the page could read the fields as they fill.
    if (pageModified) {
      return { status: "page_modified" } satisfies PreviewSignInResult;
    }

    // The origin comes from the committed main frame, never from the agent.
    const frame = guest.mainFrame;
    const pageOrigin = frame.origin;
    if (!isFillableOrigin(pageOrigin) || !guest.session.isPersistent()) {
      return { status: "unavailable" } satisfies PreviewSignInResult;
    }

    const saved = yield* vault.loginsFor(pageOrigin).pipe(Effect.orElseSucceed(() => []));
    const account = request.account?.trim();
    const candidates =
      account === undefined || account === ""
        ? saved
        : saved.filter((entry) => entry.username === account);
    if (candidates.length === 0) {
      return { status: "unavailable" } satisfies PreviewSignInResult;
    }

    const selectors = {
      passwordSelector: request.passwordSelector,
      usernameSelector: request.usernameSelector ?? null,
      submitSelector: request.submitSelector ?? null,
    };
    const fields = yield* Effect.tryPromise(() =>
      runInSignInWorld(guest, checkFields, selectors),
    ).pipe(Effect.orElseSucceed(() => null));
    if (fields === null || !fields.password || !fields.username || !fields.submit) {
      return { status: "locator_invalid" } satisfies PreviewSignInResult;
    }

    const declineKey = `${guest.id}\u0000${pageOrigin}`;
    if ((declinedUntil.get(declineKey) ?? 0) > (yield* Clock.currentTimeMillis)) {
      return { status: "declined" } satisfies PreviewSignInResult;
    }

    const decision = yield* approval.approve({
      guest,
      site: new URL(pageOrigin).host,
      accounts: [...new Set(candidates.map((entry) => entry.username))],
    });
    if (decision === "unavailable") {
      return { status: "unavailable" } satisfies PreviewSignInResult;
    }
    if (decision === "declined") {
      declinedUntil.set(declineKey, (yield* Clock.currentTimeMillis) + DECLINE_COOLDOWN_MS);
      return { status: "declined" } satisfies PreviewSignInResult;
    }
    const approvedAccount = decision.account;

    // Approval can take a while; the page may have moved on in the meantime.
    if (frame.isDestroyed() || guest.mainFrame !== frame || frame.origin !== pageOrigin) {
      return { status: "origin_changed" } satisfies PreviewSignInResult;
    }
    const login = candidates.find((entry) => entry.username === approvedAccount);
    if (login === undefined) {
      return { status: "unavailable" } satisfies PreviewSignInResult;
    }

    // The page only ever holds a stand-in; the real password replaces it in
    // the sign-in request to this origin. The agent is still kept off the page
    // and the page's requests guarded, in case the swap is ever bypassed.
    lock(login.password);
    guardPasswordSubmission({ guest, secret: login.password, pageOrigin, scope: "origin" });
    const standIn = makeStandIn(login.password);
    const substitution = substitute({ standIn, password: login.password, pageOrigin });
    const armed = yield* Effect.tryPromise(() => substitution.ready).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!armed) {
      substitution.cancel();
      return { status: "unavailable" } satisfies PreviewSignInResult;
    }
    const filled = yield* Effect.tryPromise(() =>
      runInSignInWorld(guest, fillAndSubmit, {
        ...selectors,
        submitWithEnter: request.submitWithEnter ?? false,
        username: login.username,
        password: standIn,
      }),
    ).pipe(Effect.orElseSucceed(() => false));
    if (!filled) {
      substitution.cancel();
      return { status: "locator_invalid" } satisfies PreviewSignInResult;
    }

    const swapped = yield* Effect.promise(() => substitution.done).pipe(
      Effect.timeoutOption(SUBSTITUTION_WAIT),
      Effect.map(Option.getOrElse(() => false)),
    );
    if (!swapped) {
      // The page sent no sign-in request we could complete, for instance
      // because it hashes the password first. Only the stand-in left.
      substitution.cancel();
      yield* Effect.promise(() =>
        runInSignInWorld(guest, clearPasswordFieldsScript, null).catch(() => undefined),
      );
      return { status: "unsupported" } satisfies PreviewSignInResult;
    }
    return { status: "submitted" } satisfies PreviewSignInResult;
  });

  return PasswordSignIn.of({
    signIn: ({ guest, request, pageModified, lock, substitute }) =>
      Option.match(decodeSignInRequest(request), {
        onNone: () => Promise.resolve({ status: "locator_invalid" } as const),
        onSome: (decoded) =>
          runPromise(
            signInEffect({ guest, request: decoded, pageModified, lock, substitute }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Agent sign-in failed", { cause }).pipe(
                  Effect.as({ status: "unavailable" } as const),
                ),
              ),
            ),
          ),
      }),
    // A page that cannot run the check (destroyed, crashed) holds nothing to guard.
    pageHoldsPassword: (guest) =>
      Promise.resolve()
        .then(() => runInSignInWorld(guest, pageHoldsPasswordScript, null))
        .catch(() => false),
    pageContainsSecret: (guest, secret) =>
      Promise.resolve()
        .then(() => runInSignInWorld(guest, pageContainsSecretScript, secret))
        .catch(() => true),
    clearPasswordFields: (guest) =>
      Promise.resolve()
        .then(() => runInSignInWorld(guest, clearPasswordFieldsScript, null))
        .catch(() => undefined),
  });
});

export const layer = Layer.effect(PasswordSignIn, make);

/** A sign-in service with no saved logins, for tests that only need a host. */
export const layerTest = Layer.succeed(
  PasswordSignIn,
  PasswordSignIn.of({
    signIn: async () => ({ status: "unavailable" }),
    pageHoldsPassword: async () => false,
    pageContainsSecret: async () => false,
    clearPasswordFields: async () => {},
  }),
);
