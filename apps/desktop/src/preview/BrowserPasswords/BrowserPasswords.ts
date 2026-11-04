// @effect-diagnostics nodeBuiltinImport:off - Opens per-profile node:sqlite vault files.
// @effect-diagnostics globalTimers:off - The clipboard is cleared on a plain timer.
import type {
  BrowserLoginSummary,
  BrowserNeverSaveEntry,
  BrowserPasswordsAddInput,
  BrowserPasswordsAddResult,
  BrowserPasswordsDeleteAllResult,
  BrowserPasswordsGatedResult,
  BrowserPasswordsRevealResult,
  BrowserPasswordsStatus,
  BrowserPasswordsUpdateInput,
  BrowserPasswordsUpdateResult,
} from "@t3tools/contracts";
import {
  BROWSER_PASSWORD_CLIPBOARD_CLEAR_MS,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { makeDeviceAuthGate, type DeviceAuthGate } from "./DeviceAuth.ts";
import { normalizeLoginOrigin, siteLabel } from "./LoginOrigin.ts";
import { DuplicateLoginError, PasswordDatabase, type SecretCipher } from "./PasswordDatabase.ts";

export class BrowserPasswordsUnavailableError extends Schema.TaggedError<BrowserPasswordsUnavailableError>()(
  "BrowserPasswordsUnavailableError",
  {
    profileId: Schema.String,
    reason: Schema.Literals(["encryptionUnavailable", "databaseUnavailable", "incognito"]),
  },
) {
  override get message(): string {
    return `Saved passwords are unavailable for browser profile ${this.profileId} (${this.reason}).`;
  }
}

/** Carries no detail from the failure: it may have touched a secret. */
export class BrowserPasswordsOperationError extends Schema.TaggedError<BrowserPasswordsOperationError>()(
  "BrowserPasswordsOperationError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Saved password ${this.operation} failed.`;
  }
}

export type BrowserPasswordsError =
  | BrowserPasswordsUnavailableError
  | BrowserPasswordsOperationError;

export interface ClipboardPort {
  readonly writeText: (text: string) => void;
  readonly readText: () => string | Promise<string>;
  readonly clear: () => void;
}

export interface BrowserPasswordsShape {
  readonly status: (profileId: string) => Effect.Effect<BrowserPasswordsStatus>;
  readonly list: (input: {
    readonly profileId: string;
    readonly query?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<BrowserLoginSummary>, BrowserPasswordsError>;
  readonly add: (
    input: BrowserPasswordsAddInput,
  ) => Effect.Effect<BrowserPasswordsAddResult, BrowserPasswordsError>;
  readonly update: (
    input: BrowserPasswordsUpdateInput,
  ) => Effect.Effect<BrowserPasswordsUpdateResult, BrowserPasswordsError>;
  readonly remove: (input: {
    readonly profileId: string;
    readonly ids: ReadonlyArray<number>;
  }) => Effect.Effect<void, BrowserPasswordsError>;
  readonly note: (input: {
    readonly profileId: string;
    readonly id: number;
  }) => Effect.Effect<string, BrowserPasswordsError>;
  /** Always asks for Touch ID (or the fallback confirm) first. */
  readonly reveal: (input: {
    readonly profileId: string;
    readonly id: number;
  }) => Effect.Effect<BrowserPasswordsRevealResult, BrowserPasswordsError>;
  /** Always asks first; writes the clipboard in main and clears it after 30 s. */
  readonly copy: (input: {
    readonly profileId: string;
    readonly id: number;
  }) => Effect.Effect<BrowserPasswordsGatedResult, BrowserPasswordsError>;
  readonly deleteAll: (
    profileId: string,
  ) => Effect.Effect<BrowserPasswordsDeleteAllResult, BrowserPasswordsError>;
  readonly neverSaveList: (
    profileId: string,
  ) => Effect.Effect<ReadonlyArray<BrowserNeverSaveEntry>, BrowserPasswordsError>;
  readonly neverSaveRemove: (input: {
    readonly profileId: string;
    readonly ids: ReadonlyArray<number>;
  }) => Effect.Effect<void, BrowserPasswordsError>;
  readonly subscribeChanges: (listener: (profileId: string) => void) => () => void;
  /** Main-process only: the open vault for save and fill, or null when unavailable. */
  readonly vault: (profileId: string) => PasswordDatabase | null;
  readonly notifyChanged: (profileId: string) => void;
  /** The device check (Touch ID or the fallback confirm). Resolves false on cancel. */
  readonly authorize: DeviceAuthGate["authorize"];
}

export class BrowserPasswords extends Context.Service<BrowserPasswords, BrowserPasswordsShape>()(
  "@t3tools/desktop/preview/BrowserPasswords/BrowserPasswords",
) {}

export const profileVaultDirectoryName = (profileId: string): string =>
  NodeCrypto.createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 32);

const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

export interface MakeBrowserPasswordsOptions {
  /** Vaults live in `<rootDirectory>/<hash(profileId)>/passwords.sqlite`. */
  readonly rootDirectory: string;
  /** Null when OS-backed encryption is unavailable: the feature is then off. */
  readonly cipher: () => SecretCipher | null;
  readonly gate: DeviceAuthGate;
  readonly clipboard: ClipboardPort;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => void;
  readonly onError?: (message: string) => void;
}

export function makeBrowserPasswords(
  options: MakeBrowserPasswordsOptions,
): BrowserPasswordsShape & {
  readonly close: () => void;
} {
  const now = options.now ?? Date.now;
  const schedule =
    options.setTimeout ?? ((callback: () => void, ms: number) => void setTimeout(callback, ms));
  const onError = options.onError ?? (() => {});
  const vaults = new Map<string, PasswordDatabase | "failed">();
  const listeners = new Set<(profileId: string) => void>();

  const emit = (profileId: string) => {
    for (const listener of listeners) {
      try {
        listener(profileId);
      } catch {
        onError("A saved password change listener failed.");
      }
    }
  };

  const unavailableReason = (
    profileId: string,
  ): "encryptionUnavailable" | "databaseUnavailable" | "incognito" | null => {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return "incognito";
    if (options.cipher() === null) return "encryptionUnavailable";
    if (vaults.get(profileId) === "failed") return "databaseUnavailable";
    return null;
  };

  const vault = (profileId: string): PasswordDatabase | null => {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return null;
    const existing = vaults.get(profileId);
    if (existing === "failed") return null;
    if (existing !== undefined) return existing;
    const cipher = options.cipher();
    // Without encryption nothing is created on disk, not even an empty file.
    if (cipher === null) return null;
    try {
      const filename = NodePath.join(
        options.rootDirectory,
        profileVaultDirectoryName(profileId),
        "passwords.sqlite",
      );
      NodeFs.mkdirSync(NodePath.dirname(filename), { recursive: true, mode: 0o700 });
      const opened = PasswordDatabase.open(filename, cipher);
      vaults.set(profileId, opened);
      return opened;
    } catch {
      vaults.set(profileId, "failed");
      onError(`Could not open the saved password vault for profile ${profileId}.`);
      return null;
    }
  };

  const use = <A>(
    operation: string,
    profileId: string,
    body: (db: PasswordDatabase) => A,
  ): Effect.Effect<A, BrowserPasswordsError> =>
    Effect.suspend((): Effect.Effect<A, BrowserPasswordsError> => {
      const db = vault(profileId);
      if (db === null) {
        return Effect.fail(
          new BrowserPasswordsUnavailableError({
            profileId,
            reason: unavailableReason(profileId) ?? "databaseUnavailable",
          }),
        );
      }
      try {
        return Effect.succeed(body(db));
      } catch {
        // The cause is dropped on purpose; it can carry decrypted values.
        return Effect.fail(new BrowserPasswordsOperationError({ operation }));
      }
    });

  const changed = <A, E>(profileId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.tap(() => Effect.sync(() => emit(profileId))));

  const authorize = (action: "reveal" | "copy" | "deleteAll", site?: string) =>
    Effect.promise(() => options.gate.authorize({ action, site }));

  return {
    vault,
    notifyChanged: emit,
    authorize: (request) => options.gate.authorize(request),
    status: (profileId) =>
      Effect.sync(() => {
        if (profileId !== INCOGNITO_BROWSER_PROFILE_ID) vault(profileId);
        const reason = unavailableReason(profileId);
        return {
          available: reason === null,
          ...(reason === null ? {} : { reason }),
          touchIdAvailable: options.gate.touchIdAvailable(),
        };
      }),
    list: (input) => use("list", input.profileId, (db) => db.list(input.query)),
    add: (input) =>
      Effect.suspend(() => {
        const target = normalizeLoginOrigin(input.url);
        if (target === null) return Effect.succeed({ kind: "invalidUrl" as const });
        if (target.insecure && input.allowInsecure !== true) {
          return Effect.succeed({ kind: "insecure" as const, origin: target.origin });
        }
        return changed(
          input.profileId,
          use("add", input.profileId, (db): BrowserPasswordsAddResult => {
            const existing = db.find(target.origin, input.username);
            if (existing !== null) {
              if (input.replaceExisting !== true) return { kind: "duplicate", id: existing.id };
              db.update(
                existing.id,
                {
                  password: input.password,
                  ...(input.note === undefined ? {} : { note: input.note }),
                },
                now(),
              );
              return { kind: "updated", id: existing.id };
            }
            const id = db.add({
              origin: target.origin,
              username: input.username,
              password: input.password,
              note: input.note,
              source: "manual",
              createdAt: now(),
            });
            return { kind: "added", id };
          }),
        );
      }),
    update: (input) =>
      changed(
        input.profileId,
        use("update", input.profileId, (db): BrowserPasswordsUpdateResult => {
          try {
            const found = db.update(
              input.id,
              { username: input.username, password: input.password, note: input.note },
              now(),
            );
            return found ? { kind: "updated" } : { kind: "notFound" };
          } catch (error) {
            if (error instanceof DuplicateLoginError) {
              return { kind: "duplicate", id: error.existingId };
            }
            throw error;
          }
        }),
      ),
    remove: (input) =>
      changed(
        input.profileId,
        use("remove", input.profileId, (db) => void db.remove(input.ids)),
      ),
    note: (input) => use("note", input.profileId, (db) => db.revealNote(input.id) ?? ""),
    reveal: (input) =>
      Effect.gen(function* () {
        const summary = yield* use("reveal", input.profileId, (db) => db.get(input.id));
        if (summary === null) return { kind: "notFound" as const };
        if (!(yield* authorize("reveal", siteLabel(summary.origin)))) {
          return { kind: "cancelled" as const };
        }
        const password = yield* use("reveal", input.profileId, (db) => db.revealPassword(input.id));
        return password === null
          ? { kind: "notFound" as const }
          : { kind: "revealed" as const, password };
      }),
    copy: (input) =>
      Effect.gen(function* () {
        const summary = yield* use("copy", input.profileId, (db) => db.get(input.id));
        if (summary === null) return { kind: "notFound" as const };
        if (!(yield* authorize("copy", siteLabel(summary.origin)))) {
          return { kind: "cancelled" as const };
        }
        return yield* use("copy", input.profileId, (db): BrowserPasswordsGatedResult => {
          const password = db.revealPassword(input.id);
          if (password === null) return { kind: "notFound" };
          options.clipboard.writeText(password);
          // Remember only a digest, so the plaintext is not held for 30 s.
          const digest = sha256(password);
          schedule(() => {
            void Promise.resolve()
              .then(() => options.clipboard.readText())
              .then((current) => {
                if (sha256(current) === digest) options.clipboard.clear();
              })
              .catch(() => {});
          }, BROWSER_PASSWORD_CLIPBOARD_CLEAR_MS);
          return { kind: "done" };
        });
      }),
    deleteAll: (profileId) =>
      Effect.gen(function* () {
        yield* use("deleteAll", profileId, () => undefined);
        if (!(yield* authorize("deleteAll"))) return { kind: "cancelled" as const };
        const count = yield* changed(
          profileId,
          use("deleteAll", profileId, (db) => db.removeAll()),
        );
        return { kind: "deleted" as const, count };
      }),
    neverSaveList: (profileId) => use("neverSaveList", profileId, (db) => db.neverSaveList()),
    neverSaveRemove: (input) =>
      changed(
        input.profileId,
        use("neverSaveRemove", input.profileId, (db) => void db.removeNeverSave(input.ids)),
      ),
    subscribeChanges: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      for (const db of vaults.values()) if (db !== "failed") db.close();
      vaults.clear();
    },
  };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const reported = new Set<string>();

  const cipher: SecretCipher = {
    encrypt: (plaintext) => Effect.runSync(safeStorage.encryptString(plaintext)),
    decrypt: (ciphertext) => Effect.runSync(safeStorage.decryptString(ciphertext)),
  };
  const gate = makeDeviceAuthGate({
    platform: environment.platform,
    canPromptTouchID: () => Electron.systemPreferences.canPromptTouchID(),
    promptTouchID: (reason) => Electron.systemPreferences.promptTouchID(reason),
    confirm: ({ message, detail, confirmLabel }) =>
      runPromise(
        Effect.gen(function* () {
          const owner = yield* electronWindow.focusedMainOrFirst;
          const { response } = yield* dialog.showMessageBox(
            {
              type: "warning",
              buttons: [confirmLabel, "Cancel"],
              defaultId: 1,
              cancelId: 1,
              message,
              detail,
            },
            owner._tag === "Some" ? owner.value : undefined,
          );
          return response === 0;
        }).pipe(Effect.orElseSucceed(() => false)),
      ),
  });

  const passwords = makeBrowserPasswords({
    rootDirectory: environment.path.join(environment.stateDir, "BrowserPasswords"),
    // Checked on every open: never fall back to plaintext.
    cipher: () =>
      Effect.runSync(safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))
        ? cipher
        : null,
    gate,
    clipboard: {
      writeText: (text) => Electron.clipboard.writeText(text),
      readText: () => Electron.clipboard.readText(),
      clear: () => Electron.clipboard.clear(),
    },
    onError: (message) => {
      if (reported.has(message)) return;
      reported.add(message);
      void runPromise(Effect.logWarning(message));
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(passwords.close));
  return BrowserPasswords.of(passwords);
});

export const layer = Layer.effect(BrowserPasswords, make);
