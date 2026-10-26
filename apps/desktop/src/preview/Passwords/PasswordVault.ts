import { PasswordImportSourceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { IpcMainInvokeEvent, WebContents } from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import { PASSWORD_FILL_CHANNEL } from "../GuestProtocol.ts";
import {
  isFillableOrigin,
  passwordMatchesOrigin,
  type ImportedPassword,
  type SavedPassword,
} from "./PasswordEntry.ts";

export class PasswordVaultError extends Schema.TaggedError<PasswordVaultError>()(
  "PasswordVaultError",
  {
    reason: Schema.Literals(["encryptionUnavailable", "readFailed", "saveFailed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The saved password vault failed: ${this.reason}.`;
  }
}

/** What the guest page gets back: the password only when it has a field for one. */
export type PasswordFill = {
  readonly username: string;
  readonly password: string | null;
};

const SavedPasswordSchema = Schema.Struct({
  origin: Schema.String,
  username: Schema.String,
  password: Schema.String,
  source: PasswordImportSourceId,
  savedAt: Schema.Number,
});

/**
 * The Chrome profile to keep syncing from, with the decryption keys read from
 * the Keychain on the first import. Keeping the keys here (encrypted with the
 * rest of the vault) lets later syncs run without another Keychain prompt.
 */
const ChromeSyncSchema = Schema.Struct({
  profileDirectory: Schema.String,
  keys: Schema.Record(Schema.String, Schema.String),
});
export type ChromeSync = typeof ChromeSyncSchema.Type;

const VaultStateSchema = Schema.Struct({
  passwords: Schema.Array(SavedPasswordSchema),
  chromeSync: Schema.NullOr(ChromeSyncSchema),
});
type VaultState = typeof VaultStateSchema.Type;
const EMPTY_VAULT: VaultState = { passwords: [], chromeSync: null };

// Vaults written before Chrome sync held only the password array.
const VaultContents = Schema.fromJsonString(
  Schema.Union([VaultStateSchema, Schema.Array(SavedPasswordSchema)]),
);
const decodeVaultContents = Schema.decodeUnknownEffect(VaultContents);
const encodeVaultContents = Schema.encodeEffect(VaultContents);

const VaultDocument = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), encryptedPasswords: Schema.String }),
);
const decodeVaultDocument = Schema.decodeUnknownEffect(VaultDocument);
const encodeVaultDocument = Schema.encodeEffect(VaultDocument);

const entryKey = (entry: { readonly origin: string; readonly username: string }) =>
  `${entry.origin}\n${entry.username}`;

/**
 * Prefers the login whose username the page already shows; otherwise the most
 * recently saved one, matching how Chrome picks a default suggestion.
 */
export const choosePasswordFill = ({
  saved,
  pageOrigin,
  typedUsername,
}: {
  readonly saved: ReadonlyArray<SavedPassword>;
  readonly pageOrigin: string;
  readonly typedUsername: string;
}): SavedPassword | undefined => {
  const matches = saved
    .filter((entry) => passwordMatchesOrigin({ savedOrigin: entry.origin, pageOrigin }))
    .toSorted((left, right) => right.savedAt - left.savedAt);
  const typed = typedUsername.trim();
  return (
    (typed === "" ? undefined : matches.find((entry) => entry.username === typed)) ?? matches[0]
  );
};

export class PasswordVault extends Context.Service<
  PasswordVault,
  {
    readonly count: Effect.Effect<number, PasswordVaultError>;
    /** Saved logins for a page origin, most recently saved first. Main process only. */
    readonly loginsFor: (
      pageOrigin: string,
    ) => Effect.Effect<ReadonlyArray<SavedPassword>, PasswordVaultError>;
    readonly chromeSync: Effect.Effect<ChromeSync | null, PasswordVaultError>;
    readonly setChromeSync: (sync: ChromeSync | null) => Effect.Effect<void, PasswordVaultError>;
    readonly save: (input: {
      readonly passwords: ReadonlyArray<ImportedPassword>;
      readonly source: PasswordImportSourceId;
      /**
       * Background syncs pass true: if the user stopped syncing or removed
       * everything while the sync was reading Chrome, nothing is written back.
       */
      readonly onlyWhileChromeSyncs: boolean;
    }) => Effect.Effect<
      { readonly imported: number; readonly updated: number },
      PasswordVaultError
    >;
    readonly clear: Effect.Effect<void, PasswordVaultError>;
    /**
     * Answers the guest's autofill requests; returns the detach function. A
     * page the agent is driving is never autofilled (agents sign in through an
     * approved `preview_sign_in`), and `onPasswordFilled` runs before a
     * password is handed to the page so the caller can keep agents off it.
     */
    readonly attachGuest: (input: {
      readonly guest: WebContents;
      readonly isAgentDriven: () => boolean;
      readonly onPasswordFilled: (password: string) => void;
    }) => () => void;
  }
>()("@t3tools/desktop/preview/Passwords/PasswordVault") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const vaultPath = path.join(environment.stateDir, "preview-passwords.json");

  // `undefined` until the file is first read, so a vault nobody uses never
  // touches the keychain.
  const cache = yield* SynchronizedRef.make<VaultState | undefined>(undefined);

  const requireEncryption = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError((cause) => new PasswordVaultError({ reason: "encryptionUnavailable", cause })),
    Effect.flatMap((available) =>
      available
        ? Effect.void
        : Effect.fail(new PasswordVaultError({ reason: "encryptionUnavailable" })),
    ),
  );

  const readVault: Effect.Effect<VaultState, PasswordVaultError> = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(vaultPath).pipe(
      Effect.map((contents): string | null => contents),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(new PasswordVaultError({ reason: "readFailed", cause: error })),
      ),
    );
    if (raw === null) {
      return EMPTY_VAULT;
    }

    yield* requireEncryption;
    return yield* decodeVaultDocument(raw).pipe(
      Effect.flatMap((document) => Effect.fromResult(Base64.decode(document.encryptedPasswords))),
      Effect.flatMap((encrypted) => safeStorage.decryptString(encrypted)),
      Effect.flatMap(decodeVaultContents),
      Effect.map((contents): VaultState =>
        "passwords" in contents ? contents : { passwords: contents, chromeSync: null },
      ),
      Effect.mapError((cause) => new PasswordVaultError({ reason: "readFailed", cause })),
    );
  });

  const writeVault = Effect.fn("PasswordVault.writeVault")(function* (state: VaultState) {
    yield* requireEncryption;
    const suffix = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => new PasswordVaultError({ reason: "saveFailed", cause })));
    const tempPath = `${vaultPath}.${suffix.replace(/-/g, "")}.tmp`;
    yield* Effect.gen(function* () {
      const encrypted = yield* safeStorage.encryptString(yield* encodeVaultContents(state));
      const document = yield* encodeVaultDocument({
        version: 1,
        encryptedPasswords: Base64.encode(encrypted),
      });
      yield* fileSystem.makeDirectory(path.dirname(vaultPath), { recursive: true });
      // Written beside the vault and renamed over it, so a crash mid-write
      // never leaves a half-written vault behind.
      yield* fileSystem.writeFileString(tempPath, `${document}\n`, { mode: 0o600 });
      yield* fileSystem.rename(tempPath, vaultPath);
    }).pipe(
      Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) => new PasswordVaultError({ reason: "saveFailed", cause })),
    );
  });

  const loaded = SynchronizedRef.modifyEffect(cache, (current) =>
    current === undefined
      ? readVault.pipe(Effect.map((state) => [state, state] as const))
      : Effect.succeed([current, current] as const),
  );

  /** Applies a change to the vault and writes it only when something changed. */
  const update = <A>(
    change: (state: VaultState) => { readonly result: A; readonly next: VaultState | null },
  ) =>
    SynchronizedRef.modifyEffect(cache, (current) =>
      Effect.gen(function* () {
        const state = current ?? (yield* readVault);
        const { result, next } = change(state);
        if (next === null) {
          return [result, state] as const;
        }
        yield* writeVault(next);
        return [result, next] as const;
      }),
    );

  const save = Effect.fn("PasswordVault.save")(function* ({
    passwords,
    source,
    onlyWhileChromeSyncs,
  }: {
    readonly passwords: ReadonlyArray<ImportedPassword>;
    readonly source: PasswordImportSourceId;
    readonly onlyWhileChromeSyncs: boolean;
  }) {
    const savedAt = yield* Clock.currentTimeMillis;
    return yield* update((state) => {
      if (onlyWhileChromeSyncs && state.chromeSync === null) {
        return { result: { imported: 0, updated: 0 }, next: null };
      }

      const byKey = new Map(state.passwords.map((entry) => [entryKey(entry), entry] as const));
      let imported = 0;
      let updated = 0;
      // Unchanged logins keep their `savedAt`, so a repeated sync does not
      // reshuffle which login is offered first.
      for (const password of passwords) {
        const key = entryKey(password);
        const existing = byKey.get(key);
        if (existing === undefined) {
          imported += 1;
        } else if (existing.password !== password.password) {
          updated += 1;
        } else {
          continue;
        }
        byKey.set(key, { ...password, source, savedAt });
      }

      return {
        result: { imported, updated },
        next: imported > 0 || updated > 0 ? { ...state, passwords: [...byKey.values()] } : null,
      };
    });
  });

  const setChromeSync = (chromeSync: ChromeSync | null) =>
    update((state) => ({ result: undefined, next: { ...state, chromeSync } }));

  // Clearing also stops the Chrome sync, so removed passwords do not come back.
  const clear = SynchronizedRef.updateEffect(cache, () =>
    fileSystem.remove(vaultPath, { force: true }).pipe(
      Effect.mapError((cause) => new PasswordVaultError({ reason: "saveFailed", cause })),
      Effect.as(EMPTY_VAULT),
    ),
  );

  const fillFor = Effect.fn("PasswordVault.fillFor")(function* ({
    pageOrigin,
    typedUsername,
    wantsPassword,
  }: {
    readonly pageOrigin: string;
    readonly typedUsername: string;
    readonly wantsPassword: boolean;
  }) {
    const { passwords: saved } = yield* loaded;
    const chosen = choosePasswordFill({ saved, pageOrigin, typedUsername });
    if (chosen === undefined) {
      return null;
    }

    return {
      username: chosen.username,
      password: wantsPassword ? chosen.password : null,
    } satisfies PasswordFill;
  });

  const attachGuest = ({
    guest,
    isAgentDriven,
    onPasswordFilled,
  }: {
    readonly guest: WebContents;
    readonly isAgentDriven: () => boolean;
    readonly onPasswordFilled: (password: string) => void;
  }) => {
    const serve = async (
      event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<PasswordFill | null> => {
      // Only the main frame runs the preload, and the page shares its JS world,
      // so the origin comes from the committed frame, never from the request.
      const frame = event.senderFrame;
      if (!frame || frame !== guest.mainFrame) {
        return null;
      }
      const pageOrigin = frame.origin;
      // Private sessions keep nothing, so they get nothing from the vault.
      if (!isFillableOrigin(pageOrigin) || !guest.session.isPersistent() || isAgentDriven()) {
        return null;
      }
      if (typeof request !== "object" || request === null) {
        return null;
      }
      const { typedUsername, wantsPassword } = request as Record<string, unknown>;

      const fill = await runPromise(
        fillFor({
          pageOrigin,
          typedUsername: typeof typedUsername === "string" ? typedUsername : "",
          wantsPassword: wantsPassword === true,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(error.message, { cause: error.cause }).pipe(Effect.as(null)),
          ),
        ),
      );

      // A password read for a document that navigated away belongs to nobody.
      const sameDocument =
        !frame.isDestroyed() && frame === guest.mainFrame && frame.origin === pageOrigin;
      if (!sameDocument || fill === null) {
        return null;
      }
      if (fill.password !== null) {
        onPasswordFilled(fill.password);
      }
      return fill;
    };

    guest.ipc.removeHandler(PASSWORD_FILL_CHANNEL);
    guest.ipc.handle(PASSWORD_FILL_CHANNEL, serve);
    return () => guest.ipc.removeHandler(PASSWORD_FILL_CHANNEL);
  };

  return PasswordVault.of({
    count: loaded.pipe(Effect.map((state) => state.passwords.length)),
    loginsFor: (pageOrigin) =>
      loaded.pipe(
        Effect.map((state) =>
          state.passwords
            .filter((entry) => passwordMatchesOrigin({ savedOrigin: entry.origin, pageOrigin }))
            .toSorted((left, right) => right.savedAt - left.savedAt),
        ),
      ),
    chromeSync: loaded.pipe(Effect.map((state) => state.chromeSync)),
    setChromeSync,
    save,
    clear,
    attachGuest,
  });
});

export const layer = Layer.effect(PasswordVault, make);
